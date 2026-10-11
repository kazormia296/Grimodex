#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
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

const RUNTIME_BUILD_IDENTITY_CAPTURE_TIMEOUT_MS = 15_000;
const RUNTIME_BUILD_IDENTITY_CAPTURE_FLAG = "--capture-runtime-build-identity";

export function parsePerformanceBenchmarkArguments(argv) {
  let outputPath = null;
  let reviewFixtureId = null;
  let retryTransientOnce = false;
  let delimiterSeen = false;
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      if (delimiterSeen) {
        throw new Error("-- may only be specified once");
      }
      delimiterSeen = true;
      continue;
    }
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

function collectBuildFiles(root, relativeDirectory) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  if (!existsSync(absoluteDirectory)) {
    throw new Error("generated-build-root-missing");
  }
  const files = [];
  for (const entry of readdirSync(absoluteDirectory, {
    withFileTypes: true,
  }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      files.push(...collectBuildFiles(root, relativePath));
    } else if (entry.isFile()) {
      const bytes = readFileSync(absolutePath);
      files.push({
        path: relativePath,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } else {
      throw new Error("generated-build-entry-not-regular-file");
    }
  }
  return files;
}

export function buildRuntimePerformanceBuildIdentity({
  projectRoot = rootDir,
  reviewFixtureId = null,
  gitHead = null,
  nativeModuleOverride = process.env.GRIMODEX_NODE_PATH ?? null,
} = {}) {
  const root = path.resolve(projectRoot);
  const resolvedGitHead =
    gitHead ??
    (() => {
      const result = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024,
      });
      if (result.status !== 0 || result.error) {
        throw new Error("git-head-unavailable");
      }
      return result.stdout.trim();
    })();
  if (!/^[0-9a-f]{40,64}$/iu.test(resolvedGitHead)) {
    throw new Error("git-head-invalid");
  }

  const fixture = buildRuntimePerformanceFixtureForReview(reviewFixtureId);
  const files = [
    ...collectBuildFiles(root, "dist"),
    ...collectBuildFiles(root, "dist-electron"),
  ];
  const defaultNativeModule = path.join(
    root,
    "electron/native/grimodex-node/grimodex-node.node",
  );
  const nativeModulePath = nativeModuleOverride
    ? path.resolve(root, nativeModuleOverride)
    : defaultNativeModule;
  const relativeNativePath = path.relative(root, nativeModulePath);
  if (
    relativeNativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeNativePath) ||
    !statSync(nativeModulePath).isFile()
  ) {
    throw new Error("native-module-identity-unavailable");
  }
  const nativeBytes = readFileSync(nativeModulePath);
  files.push({
    path: relativeNativePath.split(path.sep).join(path.posix.sep),
    size: nativeBytes.byteLength,
    sha256: createHash("sha256").update(nativeBytes).digest("hex"),
  });
  files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  for (const requiredPath of [
    "dist/index.html",
    "dist-electron/main.cjs",
    "dist-electron/preload.cjs",
  ]) {
    if (!files.some((file) => file.path === requiredPath)) {
      throw new Error("generated-build-entry-missing");
    }
  }

  const electronPackagePath = path.join(
    root,
    "node_modules/electron/package.json",
  );
  const electronPackage = JSON.parse(readFileSync(electronPackagePath, "utf8"));
  if (typeof electronPackage.version !== "string") {
    throw new Error("electron-runtime-identity-unavailable");
  }
  const fixtureJson = JSON.stringify(fixture);
  return {
    schemaVersion: 1,
    gitHead: resolvedGitHead,
    runtime: { node: process.version, electron: electronPackage.version },
    fixture: {
      id: fixture.id,
      reviewFixtureId: fixture.reviewFixtureId ?? null,
      sha256: createHash("sha256").update(fixtureJson).digest("hex"),
    },
    generatedBuild: {
      sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
      files,
    },
  };
}

export function writeRuntimePerformanceBuildIdentityArtifact(
  outputPath,
  { reviewFixtureId = null } = {},
) {
  const target = path.resolve(rootDir, outputPath);
  let artifact;
  try {
    artifact = {
      schemaVersion: 1,
      status: "captured",
      run: {
        id: process.env.GITHUB_RUN_ID ?? null,
        attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      },
      identity: buildRuntimePerformanceBuildIdentity({ reviewFixtureId }),
    };
  } catch {
    artifact = {
      schemaVersion: 1,
      status: "unavailable",
      reason: "build-identity-unavailable",
    };
  }

  const temporaryPath = `${target}.tmp-${process.pid}`;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(artifact)}\n`, {
      mode: 0o600,
    });
    renameSync(temporaryPath, target);
    return artifact.status === "captured";
  } catch {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Optional diagnostic metadata must not change the runtime-gate result.
    }
    return false;
  }
}

export function captureRuntimePerformanceBuildIdentity(
  outputPath,
  { reviewFixtureId = null } = {},
) {
  const target = path.resolve(rootDir, outputPath);
  try {
    rmSync(target, { force: true });
    const args = [
      fileURLToPath(import.meta.url),
      RUNTIME_BUILD_IDENTITY_CAPTURE_FLAG,
      "--output",
      target,
    ];
    if (reviewFixtureId) args.push("--review-fixture", reviewFixtureId);
    const result = spawnSync(process.execPath, args, {
      cwd: rootDir,
      env: process.env,
      stdio: "ignore",
      timeout: RUNTIME_BUILD_IDENTITY_CAPTURE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (result.error || result.status !== 0) return null;
    const artifact = JSON.parse(readFileSync(target, "utf8"));
    return artifact.status === "captured" ? artifact : null;
  } catch {
    return null;
  }
}

function runRuntimePerformanceBuildIdentityCapture(argv) {
  let options;
  try {
    options = parsePerformanceBenchmarkArguments([
      argv[0],
      argv[1],
      ...argv.slice(3),
    ]);
  } catch {
    return 2;
  }
  if (!options.outputPath || options.retryTransientOnce) return 2;
  return writeRuntimePerformanceBuildIdentityArtifact(options.outputPath, {
    reviewFixtureId: options.reviewFixtureId,
  })
    ? 0
    : 1;
}

export function prepareRuntimePerformanceArtifacts(metricsPath) {
  const attemptPaths = buildRuntimePerformanceAttemptPaths(metricsPath);
  const evidencePaths = [
    ...Object.values(attemptPaths),
    ...Object.values(attemptPaths).map(
      buildRuntimePerformanceTimeoutArtifactPath,
    ),
  ];
  mkdirSync(path.dirname(attemptPaths.canonical), { recursive: true });
  for (const evidencePath of evidencePaths) {
    rmSync(evidencePath, { force: true });
  }
  return attemptPaths;
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
  const attemptPaths = prepareRuntimePerformanceArtifacts(metricsPath);
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
  if (
    process.env.GRIMODEX_PERF_CAPTURE_BUILD_IDENTITY === "1" &&
    !captureRuntimePerformanceBuildIdentity(
      ".artifacts/electron-runtime-performance/build-identity.json",
      { reviewFixtureId: options.reviewFixtureId },
    )
  ) {
    console.warn("[electron:perf] optional build identity unavailable");
  }
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
  process.exit(
    process.argv[2] === RUNTIME_BUILD_IDENTITY_CAPTURE_FLAG
      ? runRuntimePerformanceBuildIdentityCapture(process.argv)
      : runPerformanceBenchmark(process.argv),
  );
}
