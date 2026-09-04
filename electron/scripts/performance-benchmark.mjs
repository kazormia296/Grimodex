#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { rootDir } from "./build.mjs";
import { buildRuntimePerformanceFixtureForReview } from "./runtime-performance-fixture.mjs";
import {
  buildRuntimePerformanceAttemptPaths,
  runRuntimePerformanceWithRetry,
} from "./runtime-performance-retry.mjs";
import {
  buildRuntimePerformanceSmokeInvocation,
  buildRuntimePerformanceTimeoutArtifactPath,
  checkFreshXvfbCapability,
} from "./performance-harness.mjs";
import {
  buildRuntimeBudgets,
  evaluateRuntimePerformance,
} from "../../scripts/runtime-performance-budget.mjs";

export function parsePerformanceBenchmarkArguments(argv) {
  let outputPath = null;
  let reviewFixtureId = null;
  let retryTransientOnce = false;
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--retry-transient-once") {
      if (retryTransientOnce) {
        throw new Error("--retry-transient-once may only be specified once");
      }
      retryTransientOnce = true;
      continue;
    }
    if (argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--output requires a file path");
      }
      outputPath = path.resolve(rootDir, value);
      index += 1;
      continue;
    }
    if (argument === "--review-fixture") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--review-fixture requires an exact fixture id");
      }
      // Resolve here so typos fail before Electron/build artifacts are touched.
      buildRuntimePerformanceFixtureForReview(value);
      reviewFixtureId = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return { outputPath, reviewFixtureId, retryTransientOnce };
}

export function buildPerformanceBenchmarkInvocation(
  { reviewFixtureId },
  metricsPath,
) {
  const smokeEnvironment = {
    GRIMODEX_PERF_OUTPUT: metricsPath,
  };
  const budgetArguments = [metricsPath];
  if (reviewFixtureId) {
    smokeEnvironment.GRIMODEX_PERF_REVIEW_FIXTURE = reviewFixtureId;
    budgetArguments.push("--review-fixture", reviewFixtureId);
  }
  return { smokeEnvironment, budgetArguments };
}

export function runPerformanceBenchmark(argv = process.argv) {
  let options;
  try {
    options = parsePerformanceBenchmarkArguments(argv);
  } catch (error) {
    console.error(`[electron:perf] ${error.message}`);
    return 2;
  }

  const xvfbCapability = checkFreshXvfbCapability({
    platform: process.platform,
    spawnSyncImpl: spawnSync,
  });
  if (!xvfbCapability.available) {
    console.error(
      `[electron:perf] Linux runtime performance requires ${xvfbCapability.command ?? "xvfb-run"}; capability check failed: ${xvfbCapability.reason}`,
    );
    return 1;
  }

  const temporaryDirectory = options.outputPath
    ? null
    : mkdtempSync(path.join(os.tmpdir(), "grimodex-electron-perf-"));
  const metricsPath =
    options.outputPath ?? path.join(temporaryDirectory, "metrics.json");
  mkdirSync(path.dirname(metricsPath), { recursive: true });
  const attemptPaths = buildRuntimePerformanceAttemptPaths(metricsPath);
  for (const candidate of Object.values(attemptPaths)) {
    rmSync(candidate, { force: true });
  }
  for (const candidate of [
    buildRuntimePerformanceTimeoutArtifactPath(metricsPath),
    buildRuntimePerformanceTimeoutArtifactPath(attemptPaths.firstEvidence),
    buildRuntimePerformanceTimeoutArtifactPath(attemptPaths.secondEvidence),
  ]) {
    rmSync(candidate, { force: true });
  }
  const smokePath = path.join(rootDir, "electron", "scripts", "smoke.mjs");
  const budgetPath = path.join(
    rootDir,
    "scripts",
    "runtime-performance-budget.mjs",
  );
  const invocation = buildPerformanceBenchmarkInvocation(options, metricsPath);
  const expectedFixture = buildRuntimePerformanceFixtureForReview(
    options.reviewFixtureId,
  );
  const executeAttempt = ({ attempt, metricsPath: attemptMetricsPath }) => {
    rmSync(attemptMetricsPath, { force: true });
    const smokeEnvironment = {
      ...invocation.smokeEnvironment,
      GRIMODEX_PERF_OUTPUT: attemptMetricsPath,
    };
    const smokeEnv = { ...process.env, ...smokeEnvironment };
    if (!options.reviewFixtureId) {
      delete smokeEnv.GRIMODEX_PERF_REVIEW_FIXTURE;
    }

    const smokeInvocation = buildRuntimePerformanceSmokeInvocation({
      attempt,
      platform: process.platform,
      nodePath: process.execPath,
      smokePath,
    });
    const {
      command: smokeCommand,
      args: smokeArguments,
      useFreshXvfb,
    } = smokeInvocation;
    if (useFreshXvfb) {
      // xvfb-run owns DISPLAY for this child. Do not let Electron discover the
      // caller's Wayland compositor while its X11 backend is selected.
      delete smokeEnv.WAYLAND_DISPLAY;
      delete smokeEnv.ELECTRON_OZONE_PLATFORM_HINT;
      smokeEnv.GDK_BACKEND = "x11";
      smokeEnv.QT_QPA_PLATFORM = "xcb";
    }
    console.log(
      `[electron:perf] measurement attempt ${attempt}${useFreshXvfb ? " (fresh Electron + Xvfb)" : ""}`,
    );
    const smoke = spawnSync(smokeCommand, smokeArguments, {
      cwd: rootDir,
      env: smokeEnv,
      stdio: "inherit",
    });
    if (smoke.status !== 0) {
      const timeoutArtifactPath =
        buildRuntimePerformanceTimeoutArtifactPath(attemptMetricsPath);
      const timedOut = existsSync(timeoutArtifactPath);
      console.error(
        `[electron:perf] smoke/measurement${timedOut ? "/watchdog" : ""} failed on attempt ${attempt}; metrics target: ${attemptMetricsPath}${timedOut ? `; timeout evidence: ${timeoutArtifactPath}` : ""}`,
      );
      return {
        status: smoke.status ?? 1,
        phase: timedOut ? "measurement-timeout" : "measurement",
        metrics: null,
        evaluation: null,
        timeoutArtifactPath: timedOut ? timeoutArtifactPath : null,
      };
    }

    const budgetArguments = [attemptMetricsPath];
    if (options.reviewFixtureId) {
      budgetArguments.push("--review-fixture", options.reviewFixtureId);
    }
    const budget = spawnSync(
      process.execPath,
      [budgetPath, ...budgetArguments],
      {
        cwd: rootDir,
        stdio: "inherit",
      },
    );
    let metrics = null;
    let evaluation = null;
    try {
      metrics = JSON.parse(readFileSync(attemptMetricsPath, "utf8"));
      evaluation = evaluateRuntimePerformance(
        metrics,
        buildRuntimeBudgets(expectedFixture),
        expectedFixture,
      );
    } catch (error) {
      console.error(
        `[electron:perf] could not read attempt ${attempt} metrics: ${error.message}`,
      );
    }

    if (budget.status !== 0 || !evaluation?.ok) {
      console.error(
        `[electron:perf] budget failed on attempt ${attempt}; metrics retained: ${attemptMetricsPath}`,
      );
      return {
        status: budget.status === 0 ? 1 : (budget.status ?? 1),
        phase: "budget",
        metrics,
        evaluation,
      };
    }

    return {
      status: 0,
      phase: "complete",
      metrics,
      evaluation,
    };
  };

  const result = runRuntimePerformanceWithRetry({
    outputPath: metricsPath,
    retryTransientOnce: options.retryTransientOnce,
    executeAttempt,
    copyMetrics: copyFileSync,
    onRecovered: (decision) => {
      const message =
        `Recovered after one transient performance retry: ` +
        `${decision.interaction} ${decision.durationMs}ms Long Task, ` +
        `${(decision.unattributedRatio * 100).toFixed(2)}% unattributed. ` +
        `Both attempt artifacts were retained.`;
      console.warn(`[electron:perf] WARNING ${message}`);
      if (process.env.GITHUB_ACTIONS === "true") {
        console.warn(`::warning title=Transient performance retry::${message}`);
      }
    },
  });
  if (result.status !== 0) return result.status;

  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    console.log("[electron:perf] PASS");
  } else {
    console.log(`[electron:perf] PASS; metrics: ${metricsPath}`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runPerformanceBenchmark(process.argv));
}
