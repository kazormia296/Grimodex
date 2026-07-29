#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { rootDir } from "./build.mjs";
import { buildRuntimePerformanceFixtureForReview } from "./runtime-performance-fixture.mjs";

export function parsePerformanceBenchmarkArguments(argv) {
  let outputPath = null;
  let reviewFixtureId = null;
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
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
  return { outputPath, reviewFixtureId };
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

  const temporaryDirectory = options.outputPath
    ? null
    : mkdtempSync(path.join(os.tmpdir(), "grimodex-electron-perf-"));
  const metricsPath =
    options.outputPath ?? path.join(temporaryDirectory, "metrics.json");
  mkdirSync(path.dirname(metricsPath), { recursive: true });
  rmSync(metricsPath, { force: true });
  const smokePath = path.join(rootDir, "electron", "scripts", "smoke.mjs");
  const budgetPath = path.join(
    rootDir,
    "scripts",
    "runtime-performance-budget.mjs",
  );
  const invocation = buildPerformanceBenchmarkInvocation(options, metricsPath);
  const smokeEnv = { ...process.env, ...invocation.smokeEnvironment };
  if (!options.reviewFixtureId) {
    delete smokeEnv.GRIMODEX_PERF_REVIEW_FIXTURE;
  }

  const smoke = spawnSync(process.execPath, [smokePath], {
    cwd: rootDir,
    env: smokeEnv,
    stdio: "inherit",
  });
  if (smoke.status !== 0) {
    console.error(
      `[electron:perf] smoke/measurement failed; metrics target: ${metricsPath}`,
    );
    return smoke.status ?? 1;
  }

  const budget = spawnSync(
    process.execPath,
    [budgetPath, ...invocation.budgetArguments],
    {
      cwd: rootDir,
      stdio: "inherit",
    },
  );
  if (budget.status !== 0) {
    console.error(
      `[electron:perf] budget failed; metrics retained: ${metricsPath}`,
    );
    return budget.status ?? 1;
  }

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
