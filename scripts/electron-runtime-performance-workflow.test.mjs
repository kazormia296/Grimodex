import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import yaml from "js-yaml";

import { closeElectronAppWithDiagnostics } from "../electron/scripts/close-electron-app.mjs";
import { prepareRuntimePerformanceArtifacts } from "../electron/scripts/performance-benchmark.mjs";
import { buildRuntimePerformanceAttemptPaths } from "../electron/scripts/runtime-performance-retry.mjs";
import {
  RUNTIME_PERFORMANCE_RAF_CALIBRATION_SAMPLE_COUNT,
  buildRuntimePerformanceSmokeInvocation,
  buildRuntimePerformanceTimeoutArtifact,
  buildRuntimePerformanceTimeoutArtifactPath,
  captureRafCalibration,
  checkFreshXvfbCapability,
  collectOwnedProcessTree,
  createRuntimePerformanceCleanupCoordinator,
  finalizeRuntimePerformanceTimeout,
  focusRuntimeWindow,
  readRuntimeWindowSnapshot,
  runRuntimePerformancePhaseSequence,
  snapshotRuntimePerformanceContext,
  snapshotRuntimeEnvironment,
  terminateOwnedProcessTree,
} from "../electron/scripts/performance-harness.mjs";
import * as runtimePerformanceHarness from "../electron/scripts/performance-harness.mjs";
import { buildLocalCiPlan, runLocalCiInvocationTasks } from "./local-ci.mjs";
import { DEFAULT_RUNTIME_BUDGETS } from "./runtime-performance-budget.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const metricsPath =
  ".artifacts/electron-runtime-performance/runtime-metrics.json";

async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function allRunCommands(job) {
  return job.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
}

function runtimeEvidencePaths(metricsPath) {
  const attemptPaths = buildRuntimePerformanceAttemptPaths(metricsPath);
  return [
    ...Object.values(attemptPaths),
    ...Object.values(attemptPaths).map(
      buildRuntimePerformanceTimeoutArtifactPath,
    ),
  ];
}

test("package.json exposes deterministic Electron runtime performance contracts", async () => {
  const packageJson = JSON.parse(await read("package.json"));

  assert.equal(
    packageJson.scripts["test:electron-perf"],
    "node --test scripts/electron-runtime-performance-workflow.test.mjs scripts/runtime-performance-fixture.test.mjs scripts/runtime-performance-budget.test.mjs scripts/runtime-performance-retry.test.mjs",
  );
  assert.equal(
    packageJson.scripts["electron:perf:ci"],
    `node electron/scripts/performance-benchmark.mjs --retry-transient-once --output ${metricsPath}`,
  );
});

test("local CI runtime evidence stays isolated across run-scoped benchmark outputs", async (t) => {
  const registry = JSON.parse(await read("scripts/local-ci-registry.json"));
  const plan = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
    from: "electron-runtime-performance",
  });
  const plannedBenchmark = plan.stages[0].commands.find(
    ({ id }) => id === "runtime.benchmark",
  );
  assert.ok(plannedBenchmark);
  assert.deepEqual(plannedBenchmark.args, [
    "electron:perf:ci",
    "--",
    "--output",
    ".artifacts/local-ci/runs/__LOCAL_CI_RUN_ID__/runtime-metrics.json",
  ]);

  const runIds = [randomUUID(), randomUUID()];
  const runRoots = runIds.map((runId) =>
    path.join(repoRoot, ".artifacts", "local-ci", "runs", runId),
  );
  t.after(() =>
    Promise.all(
      runRoots.map((runRoot) => rm(runRoot, { recursive: true, force: true })),
    ),
  );

  const executeRun = async (runId, marker, benchmarkExitCode) => {
    const written = [];
    let benchmarkCommand = null;
    const result = await runLocalCiInvocationTasks(plan, {
      root: repoRoot,
      runId,
      executeCommand: async (command) => {
        if (command.args[0] !== "electron:perf:ci") {
          return { cleanup: { complete: true }, durationMs: 1, exitCode: 0 };
        }
        benchmarkCommand = structuredClone(command);
        const outputIndex = command.args.indexOf("--output");
        assert.equal(command.args[outputIndex - 1], "--");
        const outputPath = path.resolve(
          repoRoot,
          command.cwd,
          command.args[outputIndex + 1],
        );
        prepareRuntimePerformanceArtifacts(outputPath);
        const evidence = runtimeEvidencePaths(outputPath);
        await Promise.all(
          evidence.map((filePath, index) =>
            writeFile(filePath, `${marker}-${index}\n`, "utf8"),
          ),
        );
        written.push(...evidence);
        return {
          cleanup: { complete: true },
          durationMs: 1,
          exitCode: benchmarkExitCode,
          signal: null,
        };
      },
    });
    return { benchmarkCommand, result, written };
  };

  const first = await executeRun(runIds[0], "run-a", 1);
  assert.equal(first.result.status, "failed");
  const firstBytes = new Map(
    await Promise.all(
      first.written.map(async (filePath) => [
        filePath,
        await readFile(filePath),
      ]),
    ),
  );
  const second = await executeRun(runIds[1], "run-b", 0);
  assert.equal(second.result.status, "passed");

  for (const [filePath, bytes] of firstBytes) {
    assert.deepEqual(await readFile(filePath), bytes);
  }
  assert.ok(
    first.written.every((filePath) =>
      filePath.startsWith(`${runRoots[0]}${path.sep}`),
    ),
  );
  assert.ok(
    second.written.every((filePath) =>
      filePath.startsWith(`${runRoots[1]}${path.sep}`),
    ),
  );
  assert.ok(
    !second.written.some((filePath) =>
      filePath.includes(
        path.join(".artifacts", "electron-runtime-performance"),
      ),
    ),
  );

  for (const [runId, expectedRoot, execution] of [
    [runIds[0], runRoots[0], first],
    [runIds[1], runRoots[1], second],
  ]) {
    const output = path.join(
      ".artifacts",
      "local-ci",
      "runs",
      runId,
      "runtime-metrics.json",
    );
    assert.notEqual(output, metricsPath);
    assert.equal(
      output,
      path.relative(repoRoot, path.join(expectedRoot, "runtime-metrics.json")),
    );
    assert.equal(execution.benchmarkCommand.command, "pnpm");
    assert.deepEqual(execution.benchmarkCommand.args, [
      "electron:perf:ci",
      "--",
      "--output",
      output,
    ]);
  }
});

test("CI runs a fixed Linux Electron runtime gate and always publishes its evidence", async () => {
  const workflow = yaml.load(await read(".github/workflows/ci.yml"));
  const job = workflow.jobs["electron-runtime-performance"];

  assert.ok(job, "electron-runtime-performance job is required");
  assert.equal(job.name, "Electron runtime performance (50k chars / 20 Beats)");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 30);

  const commands = allRunCommands(job);
  assert.match(commands, /pnpm test:electron-perf/);
  assert.match(commands, /pnpm exec playwright install-deps chromium/);
  assert.match(commands, /pnpm napi:build/);
  assert.match(commands, /pnpm electron:build/);
  assert.match(
    commands,
    /xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" pnpm electron:perf:ci/,
  );

  const upload = job.steps.find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact@"),
  );
  assert.ok(upload, "runtime metrics must be uploaded");
  assert.equal(upload.if, "always()");
  assert.equal(upload.with.path, ".artifacts/electron-runtime-performance/");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["retention-days"], 14);
});

test("runtime frame gate pins active-foreground Chromium timing semantics", async () => {
  const source = await read("electron/scripts/smoke.mjs");
  for (const flag of [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ]) {
    assert.match(source, new RegExp(`"${flag}"`));
  }
  assert.match(
    source,
    /if \(performanceOutputPath\) \{\s+[\s\S]*?args\.push\(\.\.\.RUNTIME_PERFORMANCE_FOREGROUND_SWITCHES\);\s+\}/,
  );
  assert.match(
    source,
    /async function ensureBenchmarkPageForeground\(page\) \{[\s\S]*?focusRuntimeWindow\([\s\S]*?await page\.bringToFront\(\);[\s\S]*?document\.visibilityState === "visible"[\s\S]*?document\.hidden === false[\s\S]*?document\.hasFocus\(\)/,
  );
  assert.match(source, /readDomForegroundSnapshot/);
  assert.match(source, /readRuntimeWindowSnapshot/);
  assert.match(source, /RUNTIME_PERFORMANCE_RAF_CALIBRATION_SAMPLE_COUNT/);
  const watchdogStart = source.indexOf("const watchdog = setTimeout");
  const watchdogEnd = source.indexOf("\ntry {", watchdogStart);
  assert.ok(watchdogStart >= 0 && watchdogEnd > watchdogStart);
  assert.doesNotMatch(
    source.slice(watchdogStart, watchdogEnd),
    /process\.exit\(/,
    "watchdog must finalize evidence before setting a non-zero exit code",
  );
  assert.match(source, /snapshotRuntimePerformanceContext\(runtimeContext\)/);
  assert.match(source, /runtimeAbortController\.abort\("global-watchdog"\)/);
  assert.match(source, /runRuntimePerformancePhaseSequence\(/);
  assert.match(
    source,
    /hardExit: \(exitCode, result\) => \{[\s\S]*?process\.exit\(exitCode\)/,
    "hard exit is only wired after the finalizer has returned from artifact flush",
  );
  assert.equal(
    source.match(/await ensureBenchmarkPageForeground\(page\);/g)?.length,
    6,
    "launch, calibration, autosave, gesture driver, Timeline, and Chronicle must all establish an active Page",
  );
});

test("smoke phase and failure cleanup wire bounded owned cleanup", async () => {
  const source = await read("electron/scripts/smoke.mjs");
  const finishStart = source.indexOf(
    "async function finishRuntimePhase({ app, page, memorySampler, phase })",
  );
  const finishEnd = source.indexOf(
    "\nasync function ensureBenchmarkPageForeground",
    finishStart,
  );
  assert.ok(finishStart >= 0 && finishEnd > finishStart);
  const finish = source.slice(finishStart, finishEnd);
  assert.match(
    finish,
    /cleanupRuntimePerformancePhase\(\{[\s\S]*?app,[\s\S]*?memorySampler,[\s\S]*?stopMemorySampler:[\s\S]*?closeApp:[\s\S]*?forceKill:[\s\S]*?operationTimeoutMs:\s*FAILURE_CLEANUP_TIMEOUT_MS,[\s\S]*?abort:/,
    "phase finally must pass every owned cleanup callback and deadline",
  );
  assert.match(
    finish,
    /if \(cleanup\.status !== "completed"\) \{[\s\S]*?throw new Error\(/,
    "failed phase cleanup must propagate to the top-level failure path",
  );
  assert.match(
    finish,
    /if \(runtimeContext\.app === app\) \{[\s\S]*?runtimeContext\.app = null[\s\S]*?runtimeContext\.page = null[\s\S]*?runtimeContext\.memorySampler = null/,
    "runtime handles must reset only after phase-finally cleanup",
  );
  assert.equal(
    source.match(/finally \{\s+await finishRuntimePhase\(/g)?.length,
    3,
    "seed, write, and restart must all clean up from finally",
  );

  const catchStart = source.lastIndexOf("} catch (e) {");
  assert.ok(catchStart >= 0, "top-level smoke failure catch is required");
  const failureCatch = source.slice(catchStart);
  const abortIndex = failureCatch.indexOf(
    'runtimeAbortController.abort("top-level-failure")',
  );
  const memoryIndex = failureCatch.search(
    /runBoundedOperation\(\s*"memorySampler"/,
  );
  const appIndex = failureCatch.search(/runBoundedOperation\(\s*"app"/);
  const clearIndex = failureCatch.indexOf("clearTimeout(watchdog)");
  assert.ok(abortIndex >= 0, "failure cleanup must abort phase work first");
  assert.ok(memoryIndex > abortIndex, "sampler cleanup must be bounded");
  assert.ok(appIndex > memoryIndex, "app cleanup must be bounded");
  assert.ok(
    clearIndex > appIndex,
    "global watchdog must remain armed during failure cleanup",
  );
  assert.match(
    failureCatch,
    /runBoundedOperation\(\s*"forceKill"/,
    "owned process fallback must also be bounded",
  );
});

test("Linux runtime performance attempts always route through a fresh Xvfb", () => {
  for (const attempt of [1, 2]) {
    const invocation = buildRuntimePerformanceSmokeInvocation({
      attempt,
      platform: "linux",
      nodePath: "/usr/bin/node",
      smokePath: "/repo/electron/scripts/smoke.mjs",
    });
    assert.equal(invocation.useFreshXvfb, true);
    assert.equal(invocation.command, "xvfb-run");
    assert.deepEqual(invocation.args, [
      "--auto-servernum",
      "--server-args=-screen 0 1920x1080x24",
      "/usr/bin/node",
      "/repo/electron/scripts/smoke.mjs",
    ]);
  }

  assert.deepEqual(
    buildRuntimePerformanceSmokeInvocation({
      platform: "darwin",
      nodePath: "/usr/bin/node",
      smokePath: "/repo/electron/scripts/smoke.mjs",
    }),
    {
      useFreshXvfb: false,
      command: "/usr/bin/node",
      args: ["/repo/electron/scripts/smoke.mjs"],
    },
  );
});

test("benchmark runner keeps measurement failures non-retryable and records timeout evidence", async () => {
  const source = await read("electron/scripts/performance-benchmark.mjs");
  assert.match(source, /buildRuntimePerformanceSmokeInvocation/);
  assert.match(source, /delete smokeEnv\.WAYLAND_DISPLAY/);
  assert.match(source, /delete smokeEnv\.ELECTRON_OZONE_PLATFORM_HINT/);
  assert.match(source, /smokeEnv\.GDK_BACKEND = "x11"/);
  assert.match(source, /smokeEnv\.QT_QPA_PLATFORM = "xcb"/);
  assert.match(
    source,
    /phase: timedOut \? "measurement-timeout" : "measurement"/,
  );
  assert.doesNotMatch(
    source,
    /attempt === 2[\s\S]*?(?:xvfb-run|useFreshXvfb)/,
    "attempt two must not be the only fresh-Xvfb path",
  );
});

test("Linux Xvfb capability is fail-closed before measurement", () => {
  const calls = [];
  const available = checkFreshXvfbCapability({
    platform: "linux",
    spawnSyncImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, error: null };
    },
  });
  assert.deepEqual(available, {
    required: true,
    available: true,
    command: "xvfb-run",
  });
  assert.deepEqual(calls, [
    { command: "xvfb-run", args: ["--help"], options: { stdio: "ignore" } },
  ]);

  const missing = checkFreshXvfbCapability({
    platform: "linux",
    spawnSyncImpl: () => ({ status: null, error: new Error("ENOENT") }),
  });
  assert.equal(missing.required, true);
  assert.equal(missing.available, false);
  assert.match(missing.reason, /ENOENT/);

  let nonLinuxCalls = 0;
  assert.deepEqual(
    checkFreshXvfbCapability({
      platform: "darwin",
      spawnSyncImpl: () => {
        nonLinuxCalls += 1;
        return { status: 1 };
      },
    }),
    { required: false, available: true, command: null },
  );
  assert.equal(nonLinuxCalls, 0);
});

test("foreground helper focuses and snapshots the native BrowserWindow", async () => {
  const calls = [];
  const browserWindow = {
    id: 7,
    webContents: { id: 8 },
    isDestroyed: () => false,
    isMinimized: () => true,
    isVisible: () => false,
    isFocused: () => true,
    getBounds: () => ({ x: 1, y: 2, width: 800, height: 600 }),
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
  const app = {
    evaluate: async (callback) =>
      await callback({
        BrowserWindow: { getAllWindows: () => [browserWindow] },
      }),
  };

  const focused = await focusRuntimeWindow(app);
  const snapshot = await readRuntimeWindowSnapshot(app);
  assert.deepEqual(calls, ["restore", "show", "focus"]);
  assert.equal(focused.available, true);
  assert.equal(focused.isFocused, true);
  assert.equal(focused.isVisible, false);
  assert.deepEqual(snapshot.bounds, { x: 1, y: 2, width: 800, height: 600 });
  assert.equal(snapshot.webContentsId, 8);
});

test("timeout evidence preserves phase, partial metrics, foreground, environment, and process context", () => {
  const environment = snapshotRuntimeEnvironment({
    DISPLAY: ":99",
    WAYLAND_DISPLAY: "wayland-0",
    XDG_SESSION_TYPE: "wayland",
  });
  const artifact = buildRuntimePerformanceTimeoutArtifact({
    reason: "global-watchdog",
    timeoutMs: 300_000,
    startedAt: "2026-08-28T00:00:00.000Z",
    timedOutAt: "2026-08-28T00:05:00.000Z",
    elapsedMs: 300_000,
    phase: "write.views.timeline",
    currentInteraction: "timelineDrag",
    partialMetrics: {
      interactions: { timelineDrag: { frameCount: 121, p95FrameMs: 1018.1 } },
    },
    rafCalibration: { sampleCount: 16, p95Ms: 1000 },
    foreground: {
      dom: { visibilityState: "visible", hasFocus: false },
      nativeWindow: { isFocused: false, isVisible: true },
    },
    environment,
    process: { pid: 1234, electronPid: 5678 },
  });

  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.kind, "electron-runtime-performance-timeout");
  assert.equal(artifact.phase, "write.views.timeline");
  assert.equal(artifact.currentInteraction, "timelineDrag");
  assert.equal(
    artifact.partialMetrics.interactions.timelineDrag.frameCount,
    121,
  );
  assert.equal(artifact.rafCalibration.sampleCount, 16);
  assert.equal(artifact.environment.DISPLAY, ":99");
  assert.equal(artifact.process.pid, 1234);
  assert.match(
    buildRuntimePerformanceTimeoutArtifactPath("/tmp/runtime-metrics.json"),
    /runtime-metrics-timeout\.json$/,
  );
});

test("rAF calibration records sixteen samples and exposes one-second cadence", async () => {
  let sampleIndex = 0;
  const progress = [];
  const calibration = await captureRafCalibration(
    {
      evaluate: async () => {
        const timestamp = sampleIndex * 1_000;
        sampleIndex += 1;
        return {
          timestamp,
          callbackNow: timestamp,
          visibilityState: "visible",
          documentHidden: false,
          documentHasFocus: true,
        };
      },
    },
    {
      sampleCount: RUNTIME_PERFORMANCE_RAF_CALIBRATION_SAMPLE_COUNT,
      onSample: (summary) => progress.push(summary.sampleCount),
    },
  );

  assert.equal(calibration.requestedSampleCount, 16);
  assert.equal(calibration.sampleCount, 16);
  assert.equal(calibration.complete, true);
  assert.equal(calibration.intervals.length, 15);
  assert.equal(calibration.p95Ms, 1_000);
  assert.equal(calibration.maxMs, 1_000);
  assert.equal(progress.at(-1), 16);
  assert.equal(calibration.samples.at(-1).visibilityState, "visible");
  assert.equal(calibration.samples.at(-1).documentHidden, false);
  assert.equal(calibration.samples.at(-1).documentHasFocus, true);
});

test("timeout finalization runs diagnostics and cleanup before writing evidence", async () => {
  const events = [];
  let written = null;
  const result = await finalizeRuntimePerformanceTimeout({
    timeoutArtifactPath: "/tmp/runtime-metrics-timeout.json",
    artifact: buildRuntimePerformanceTimeoutArtifact({
      reason: "global-watchdog",
      timeoutMs: 300_000,
      phase: "write.views.timeline",
      currentInteraction: "timelineDrag",
      partialMetrics: { interactions: { timelineDrag: { frameCount: 121 } } },
      rafCalibration: { sampleCount: 8 },
    }),
    collectDiagnostics: async () => {
      events.push("diagnostics");
      return {
        foreground: {
          dom: { visibilityState: "visible", hasFocus: false },
          nativeWindow: { isFocused: false, isVisible: true },
        },
        process: { electronPid: 5678 },
        environment: { DISPLAY: ":99" },
      };
    },
    finalizeSession: async () => events.push("session"),
    stopMemorySampler: async () => events.push("memory"),
    closeApp: async () => events.push("close"),
    forceKill: async () => events.push("kill"),
    writeArtifact: async (filePath, finalArtifact) => {
      events.push("write");
      written = { filePath, finalArtifact };
    },
  });

  assert.deepEqual(events, [
    "diagnostics",
    "session",
    "memory",
    "close",
    "write",
  ]);
  assert.equal(result.path, "/tmp/runtime-metrics-timeout.json");
  assert.equal(written.finalArtifact.phase, "write.views.timeline");
  assert.equal(
    written.finalArtifact.partialMetrics.interactions.timelineDrag.frameCount,
    121,
  );
  assert.equal(written.finalArtifact.diagnostics.process.electronPid, 5678);
  assert.equal(written.finalArtifact.cleanup.memorySampler.status, "completed");
  assert.equal(written.finalArtifact.cleanup.session.status, "completed");
  assert.equal(written.finalArtifact.cleanup.app.status, "completed");
  assert.equal(written.finalArtifact.cleanup.forceKill.status, "skipped");
  assert.equal(
    written.finalArtifact.cleanup.processTermination.reason,
    "close-completed",
  );
});

test("timeout snapshots freeze runtime handles before later phase mutation", () => {
  const app = { process: () => ({ pid: 4321, exitCode: null }) };
  const page = { id: "page-at-timeout" };
  const memorySampler = { id: "sampler-at-timeout" };
  const context = {
    startedAt: "2026-08-28T00:00:00.000Z",
    startedAtMonotonic: 10,
    phase: "write.views.timeline",
    currentInteraction: "timelineDrag",
    app,
    page,
    memorySampler,
    foreground: { dom: { hasFocus: false } },
    rafCalibration: { sampleCount: 16, p95Ms: 1_000 },
    partialMetrics: { interactions: { timelineDrag: { frameCount: 121 } } },
    cleanupCoordinator: createRuntimePerformanceCleanupCoordinator(),
  };

  const snapshot = snapshotRuntimePerformanceContext(context, {
    now: () => 1_787_577_600_000,
    monotonicNow: () => 42,
    nodeProcess: {
      pid: 99,
      ppid: 1,
      platform: "linux",
      execPath: "/usr/bin/node",
      argv: ["node", "smoke.mjs"],
      version: "v22.0.0",
    },
    environment: { DISPLAY: ":99", XDG_SESSION_TYPE: "x11" },
  });

  context.phase = "restart";
  context.currentInteraction = "chroniclePan";
  context.app = null;
  context.page = null;
  context.memorySampler = null;
  context.foreground.dom.hasFocus = true;
  context.partialMetrics.interactions.timelineDrag.frameCount = 0;

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(snapshot.phase, "write.views.timeline");
  assert.equal(snapshot.currentInteraction, "timelineDrag");
  assert.equal(snapshot.app, app);
  assert.equal(snapshot.page, page);
  assert.equal(snapshot.memorySampler, memorySampler);
  assert.equal(snapshot.process.electron.pid, 4321);
  assert.equal(snapshot.foreground.dom.hasFocus, false);
  assert.equal(
    snapshot.partialMetrics.interactions.timelineDrag.frameCount,
    121,
  );
  assert.equal(snapshot.elapsedMs, 32);
});

test("phase boundary abort prevents the next phase from starting", async () => {
  const controller = new AbortController();
  const events = [];
  await assert.rejects(
    runRuntimePerformancePhaseSequence({
      signal: controller.signal,
      phases: [
        async () => {
          events.push("phase1");
          controller.abort("watchdog");
        },
        async () => events.push("phase2"),
      ],
    }),
    /aborted/,
  );
  assert.deepEqual(events, ["phase1"]);
});

test("normal and timeout cleanup share one close and sampler promise", async () => {
  const calls = [];
  const coordinator = createRuntimePerformanceCleanupCoordinator();
  const app = { id: "owned-app" };
  const page = { id: "owned-page" };
  const sampler = {
    stop: async () => {
      calls.push("memory");
      return { stopped: true };
    },
  };
  const close = async () => {
    calls.push("close");
  };
  const snapshot = snapshotRuntimePerformanceContext(
    {
      startedAt: "2026-08-28T00:00:00.000Z",
      phase: "write.views.timeline",
      currentInteraction: "timelineDrag",
      app,
      page,
      memorySampler: sampler,
      cleanupCoordinator: coordinator,
      childProcess: { pid: 4322, exitCode: null },
    },
    { nodeProcess: { pid: 99, platform: "linux" } },
  );

  const normalCleanup = Promise.all([
    coordinator.stopMemorySampler(sampler),
    coordinator.closeApp(app, page, snapshot.phase, close),
  ]);
  const timeoutCleanup = finalizeRuntimePerformanceTimeout({
    timeoutArtifactPath: "/tmp/runtime-metrics-coordinator-timeout.json",
    artifact: buildRuntimePerformanceTimeoutArtifact({
      phase: snapshot.phase,
      currentInteraction: snapshot.currentInteraction,
    }),
    collectDiagnostics: async () => null,
    finalizeSession: async () => null,
    stopMemorySampler: () =>
      snapshot.cleanupCoordinator.stopMemorySampler(snapshot.memorySampler),
    closeApp: () =>
      snapshot.cleanupCoordinator.closeApp(
        snapshot.app,
        snapshot.page,
        snapshot.phase,
        close,
      ),
    forceKill: async () => calls.push("kill"),
    writeArtifact: async () => calls.push("write"),
  });

  await Promise.all([normalCleanup, timeoutCleanup]);
  assert.deepEqual(calls, ["memory", "close", "write"]);
});

test("owned process termination never targets a sibling and records bounded signals", async () => {
  const killed = [];
  const processTable = [
    { pid: 700, ppid: 1 },
    { pid: 701, ppid: 700 },
    { pid: 702, ppid: 701 },
    { pid: 703, ppid: 1 },
  ];
  assert.deepEqual(collectOwnedProcessTree(700, processTable), [702, 701, 700]);

  const result = await terminateOwnedProcessTree({
    childProcessSnapshot: { pid: 700, exitCode: null, signalCode: null },
    platform: "linux",
    processTable,
    killImpl: (pid, signal) => killed.push({ pid, signal }),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.pids, [702, 701, 700]);
  assert.deepEqual(killed, [
    { pid: 702, signal: "SIGTERM" },
    { pid: 702, signal: "SIGKILL" },
    { pid: 701, signal: "SIGTERM" },
    { pid: 701, signal: "SIGKILL" },
    { pid: 700, signal: "SIGTERM" },
    { pid: 700, signal: "SIGKILL" },
  ]);
  assert.equal(
    killed.some(({ pid }) => pid === 703),
    false,
  );
});

test("unavailable Windows killer still flushes timeout artifact", async () => {
  const events = [];
  let written = null;
  const result = await finalizeRuntimePerformanceTimeout({
    timeoutArtifactPath: "/tmp/runtime-metrics-windows-timeout.json",
    artifact: buildRuntimePerformanceTimeoutArtifact({
      phase: "write.views.timeline",
      currentInteraction: "timelineDrag",
    }),
    collectDiagnostics: async () => null,
    finalizeSession: async () => null,
    stopMemorySampler: async () => null,
    closeApp: async () => {
      events.push("close");
      throw new Error("close timed out");
    },
    forceKill: async () => {
      events.push("kill");
      return await terminateOwnedProcessTree({
        childProcessSnapshot: { pid: 800, exitCode: null },
        platform: "win32",
        spawnSyncImpl: () => ({
          status: null,
          error: Object.assign(new Error("taskkill unavailable"), {
            code: "ENOENT",
          }),
        }),
      });
    },
    writeArtifact: async (filePath, finalArtifact) => {
      events.push("write");
      written = { filePath, finalArtifact };
    },
  });

  assert.deepEqual(events, ["close", "kill", "write"]);
  assert.equal(result.path, "/tmp/runtime-metrics-windows-timeout.json");
  assert.equal(
    written.finalArtifact.cleanup.processTermination.status,
    "unavailable",
  );
  assert.match(
    written.finalArtifact.cleanup.processTermination.reason,
    /ENOENT|unavailable/,
  );
});

test("timeout finalization reaches hard exit after artifact writer rejection", async () => {
  const events = [];
  const result = await finalizeRuntimePerformanceTimeout({
    timeoutArtifactPath: "/tmp/runtime-metrics-writer-rejected.json",
    artifact: buildRuntimePerformanceTimeoutArtifact({
      phase: "write.views.timeline",
      currentInteraction: "timelineDrag",
    }),
    operationTimeoutMs: 25,
    writeArtifact: async () => {
      events.push("write");
      throw new Error("artifact writer failed");
    },
    hardExit: (exitCode, hardExitResult) => {
      events.push("hardExit");
      assert.equal(exitCode, 1);
      assert.equal(hardExitResult.writeArtifact.status, "failed");
    },
  });

  assert.deepEqual(events, ["write", "hardExit"]);
  assert.equal(result.writeArtifact.status, "failed");
});

test(
  "timeout finalization reaches hard exit after artifact writer never settles",
  { timeout: 500 },
  async () => {
    const events = [];
    const result = await finalizeRuntimePerformanceTimeout({
      timeoutArtifactPath: "/tmp/runtime-metrics-writer-pending.json",
      artifact: buildRuntimePerformanceTimeoutArtifact({
        phase: "write.views.timeline",
        currentInteraction: "timelineDrag",
      }),
      operationTimeoutMs: 25,
      writeArtifact: async () => {
        events.push("write");
        return await new Promise(() => {});
      },
      hardExit: (exitCode, hardExitResult) => {
        events.push("hardExit");
        assert.equal(exitCode, 1);
        assert.equal(hardExitResult.writeArtifact.status, "timed-out");
      },
    });

    assert.deepEqual(events, ["write", "hardExit"]);
    assert.equal(result.writeArtifact.status, "timed-out");
  },
);

test(
  "phase-finally cleanup aborts and force-kills after a never-settling sampler and app",
  { timeout: 500 },
  async () => {
    const events = [];
    const controller = new AbortController();
    const startedAt = performance.now();
    const result =
      await runtimePerformanceHarness.cleanupRuntimePerformancePhase({
        app: { id: "owned-app" },
        page: { id: "owned-page" },
        phase: "seed",
        memorySampler: { id: "owned-sampler" },
        operationTimeoutMs: 25,
        stopMemorySampler: async () => {
          events.push("sampler");
          return await new Promise(() => {});
        },
        closeApp: async () => {
          events.push("close");
          return await new Promise(() => {});
        },
        forceKill: async () => {
          events.push("forceKill");
          return { status: "completed", pids: [1234] };
        },
        abort: (reason) => {
          events.push(`abort:${reason}`);
          controller.abort(reason);
        },
      });

    assert.ok(performance.now() - startedAt < 250);
    assert.equal(result.status, "failed");
    assert.deepEqual(events, [
      "sampler",
      "abort:phase-cleanup-timeout",
      "close",
      "forceKill",
    ]);
    assert.equal(result.memorySampler.status, "timed-out");
    assert.equal(result.app.status, "timed-out");
    assert.equal(result.forceKill.status, "completed");
    assert.equal(controller.signal.reason, "phase-cleanup-timeout");
  },
);

test("phase-finally cleanup shares normal owned cleanup across duplicate calls", async () => {
  const events = [];
  const coordinator = createRuntimePerformanceCleanupCoordinator();
  const app = { id: "owned-app" };
  const page = { id: "owned-page" };
  const sampler = { id: "owned-sampler" };
  const close = async () => {
    events.push("close");
  };
  const stopMemorySampler = () =>
    coordinator.stopMemorySampler({
      ...sampler,
      stop: async () => {
        events.push("sampler");
      },
    });
  const closeApp = () => coordinator.closeApp(app, page, "seed", close);
  const forceKill = () =>
    coordinator.terminateProcess(async () => {
      events.push("forceKill");
      return { status: "completed" };
    });
  const run = () =>
    runtimePerformanceHarness.cleanupRuntimePerformancePhase({
      app,
      page,
      phase: "seed",
      memorySampler: sampler,
      cleanupCoordinator: coordinator,
      stopMemorySampler,
      closeApp,
      forceKill,
      operationTimeoutMs: 25,
    });

  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.deepEqual(events, ["sampler", "close"]);
  assert.deepEqual(coordinator.snapshot(), {
    memoryStopStarted: true,
    closeStarted: true,
    terminationStarted: false,
  });
});

test("phase-finally cleanup absorbs a late sampler rejection after its deadline", async () => {
  const events = [];
  let rejectSampler;
  const lateSampler = new Promise((resolve, reject) => {
    rejectSampler = reject;
  });
  const result = await runtimePerformanceHarness.cleanupRuntimePerformancePhase(
    {
      app: { id: "owned-app" },
      page: { id: "owned-page" },
      phase: "write",
      memorySampler: { id: "owned-sampler" },
      operationTimeoutMs: 10,
      stopMemorySampler: () => lateSampler,
      closeApp: async () => {
        events.push("close");
      },
      forceKill: async () => {
        events.push("forceKill");
        return { status: "completed" };
      },
      abort: (reason) => events.push(`abort:${reason}`),
    },
  );

  assert.equal(result.status, "failed");
  assert.deepEqual(events, ["abort:phase-cleanup-timeout", "close"]);
  rejectSampler(new Error("late sampler failure"));
  await new Promise((resolve) => setImmediate(resolve));
});

test("phase-finally cleanup fails closed for missing required callbacks", async () => {
  const missingSampler =
    await runtimePerformanceHarness.cleanupRuntimePerformancePhase({
      app: { id: "owned-app" },
      page: { id: "owned-page" },
      phase: "seed",
      memorySampler: { id: "owned-sampler" },
      closeApp: async () => null,
      abort: () => {},
      operationTimeoutMs: 25,
    });
  assert.equal(missingSampler.status, "failed");
  assert.equal(missingSampler.memorySampler.status, "failed");
  assert.match(
    missingSampler.memorySampler.error.message,
    /memorySampler.*callback.*required/i,
  );

  const missingApp =
    await runtimePerformanceHarness.cleanupRuntimePerformancePhase({
      app: { id: "owned-app" },
      page: { id: "owned-page" },
      phase: "write",
      forceKill: async () => ({ status: "completed" }),
      abort: () => {},
      operationTimeoutMs: 25,
    });
  assert.equal(missingApp.status, "failed");
  assert.equal(missingApp.app.status, "failed");
  assert.match(missingApp.app.error.message, /app.*callback.*required/i);
  assert.equal(missingApp.forceKill.status, "completed");

  const missingForceKill =
    await runtimePerformanceHarness.cleanupRuntimePerformancePhase({
      app: { id: "owned-app" },
      page: { id: "owned-page" },
      phase: "restart",
      closeApp: async () => {
        throw new Error("close failed");
      },
      abort: () => {},
      operationTimeoutMs: 25,
    });
  assert.equal(missingForceKill.status, "failed");
  assert.equal(missingForceKill.app.status, "failed");
  assert.equal(missingForceKill.forceKill.status, "failed");
  assert.match(
    missingForceKill.forceKill.error.message,
    /forceKill.*callback.*required/i,
  );

  const closeSucceeded =
    await runtimePerformanceHarness.cleanupRuntimePerformancePhase({
      app: { id: "owned-app" },
      page: { id: "owned-page" },
      phase: "seed",
      closeApp: async () => null,
      abort: () => {},
      operationTimeoutMs: 25,
    });
  assert.equal(closeSucceeded.status, "completed");
  assert.deepEqual(closeSucceeded.forceKill, {
    status: "skipped",
    reason: "close-completed",
  });
});

test("process-level timeout harness flushes JSON before hard exit with a live handle", () => {
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "grimodex-runtime-timeout-hard-exit-"),
  );
  const artifactPath = path.join(temporaryRoot, "timeout.json");
  const helperUrl = pathToFileURL(
    path.join(repoRoot, "electron/scripts/performance-harness.mjs"),
  ).href;
  const childSource = `
    import {
      finalizeRuntimePerformanceTimeout,
      terminateOwnedProcessTree,
    } from ${JSON.stringify(helperUrl)};

    // Keep a live harness handle so process.exitCode alone would hang until
    // the parent watchdog kills this child.
    const livePlaywrightHandle = setInterval(() => {}, 1_000);
    void livePlaywrightHandle;
    await finalizeRuntimePerformanceTimeout({
      timeoutArtifactPath: ${JSON.stringify(artifactPath)},
      artifact: {
        reason: "global-watchdog",
        timeoutMs: 300_000,
        phase: "write.views.timeline",
        currentInteraction: "timelineDrag",
      },
      collectDiagnostics: async () => null,
      finalizeSession: async () => null,
      stopMemorySampler: async () => null,
      closeApp: async () => {
        throw new Error("close timed out");
      },
      forceKill: async () =>
        terminateOwnedProcessTree({
          childProcessSnapshot: { pid: 9123, exitCode: null },
          platform: "win32",
          spawnSyncImpl: () => ({
            status: null,
            error: Object.assign(new Error("taskkill unavailable: ENOENT"), {
              code: "ENOENT",
            }),
          }),
        }),
      hardExit: (exitCode) => process.exit(exitCode),
    });
  `;

  try {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", childSource],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 2_000,
      },
    );
    assert.equal(
      child.error,
      undefined,
      `child harness exceeded its bounded exit window:\n${child.stderr}`,
    );
    assert.equal(child.status, 1, child.stderr);
    assert.equal(child.signal, null);
    const serializedArtifact = readFileSync(artifactPath, "utf8");
    const artifact = JSON.parse(serializedArtifact);
    assert.equal(artifact.kind, "electron-runtime-performance-timeout");
    assert.equal(artifact.phase, "write.views.timeline");
    assert.equal(artifact.cleanup.app.status, "failed");
    assert.equal(artifact.cleanup.processTermination.status, "unavailable");
    assert.match(artifact.cleanup.processTermination.reason, /ENOENT/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("runtime budget thresholds remain product constants while the harness changes", () => {
  assert.equal(DEFAULT_RUNTIME_BUDGETS.interactionFrameMeanMs, 17.5);
  assert.equal(DEFAULT_RUNTIME_BUDGETS.interactionFrameP95Ms, 17.5);
  assert.equal(DEFAULT_RUNTIME_BUDGETS.interactionFrameCatastrophicMaxMs, 50.1);
  assert.equal(DEFAULT_RUNTIME_BUDGETS.interactionFrameMinimumSamples, 120);
  assert.equal(DEFAULT_RUNTIME_BUDGETS.interactionWorkFrameMinimumSamples, 120);
});

test("Chronicle runtime readiness proves full state with a bounded DOM projection", async () => {
  const source = await read("electron/scripts/smoke.mjs");
  const start = source.indexOf(
    "async function measureChroniclePan(page, memorySampler)",
  );
  const end = source.indexOf("function shouldMeasureReviewScenario", start);
  const measure = source.slice(start, end);

  assert.match(measure, /data-chronicle-total-event-count/);
  assert.match(measure, /data-chronicle-rendered-marker-count/);
  assert.match(measure, /data-chronicle-total-edge-count/);
  assert.match(measure, /data-chronicle-rendered-edge-count/);
  assert.match(measure, /renderedMarkers > 0/);
  assert.match(measure, /renderedMarkers < totalEvents/);
  assert.doesNotMatch(
    measure,
    /querySelectorAll\("#chronicle-track \[data-event-id\]"\)\.length\s*>=/,
  );
});

test("Chronicle frame driver exercises vertical window replacement and verifies it", async () => {
  const source = await read("electron/scripts/smoke.mjs");
  assert.match(source, /scrollViewportHeight \* 1\.5/);
  assert.match(
    source,
    /markerProjection\.totalEdgeCount >=\s+Math\.min\(Math\.max\(PERF_CHRONICLE_EVENT_COUNT - 1, 0\), 1_000\)/,
  );
  assert.doesNotMatch(
    source,
    /Math\.max\(markerProjection\.totalEventCount - 1, 0\)/,
  );
  assert.match(source, /finalScrollTop > initialScrollTop/);
  assert.match(
    source,
    /finalRenderWindowTop > markerProjection\.renderWindowTop/,
  );
  assert.match(source, /markerWindowReplaced/);
  assert.match(
    source,
    /finalRenderedMarkerCount < markerProjection\.totalEventCount/,
  );
});

test("large-view runtime measurements close each panel before opening the next", async () => {
  const source = await read("electron/scripts/smoke.mjs");
  const start = source.indexOf(
    "async function sampleLargeFixtureViews(page, memorySampler)",
  );
  const end = source.indexOf("// ── フェーズ 1:", start);
  const sampleViews = source.slice(start, end);

  const mapMeasure = sampleViews.indexOf(
    "await measureMapView(page, memorySampler);",
  );
  const mapClose = sampleViews.indexOf('"map"', mapMeasure);
  const timelineMeasure = sampleViews.indexOf(
    "await measureTimelineView(page, memorySampler);",
  );
  const timelineClose = sampleViews.indexOf('"timeline"', timelineMeasure);
  const chronicleMeasure = sampleViews.indexOf(
    "await measureChroniclePan(page, memorySampler);",
  );
  const chronicleClose = sampleViews.indexOf('"chronicle"', chronicleMeasure);

  assert.ok(mapMeasure >= 0 && mapClose > mapMeasure);
  assert.ok(timelineMeasure > mapClose && timelineClose > timelineMeasure);
  assert.ok(
    chronicleMeasure > timelineClose && chronicleClose > chronicleMeasure,
  );
});

class FakeElectronProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 1234;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.kill = () => {
      this.killed = true;
      return true;
    };
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function pendingPromise() {
  return new Promise(() => {});
}

test("Electron close accepts main-process exit even if Playwright close never settles", async () => {
  const childProcess = new FakeElectronProcess();
  const page = {
    isClosed: () => true,
    evaluate: () => {
      throw new Error("closed Page must not be inspected");
    },
  };
  const close = closeElectronAppWithDiagnostics(
    {
      process: () => childProcess,
      close: pendingPromise,
    },
    page,
    "restart",
    { timeoutMs: 50 },
  );

  childProcess.exit();
  await close;
});

test("Electron close waits briefly for process exit after the Page has closed", async () => {
  const childProcess = new FakeElectronProcess();
  let evaluateCalls = 0;
  const close = closeElectronAppWithDiagnostics(
    {
      process: () => childProcess,
      close: pendingPromise,
    },
    {
      isClosed: () => true,
      evaluate: () => {
        evaluateCalls += 1;
      },
    },
    "restart",
    {
      timeoutMs: 5,
      processExitGraceMs: 100,
      pageDiagnosticsTimeoutMs: 5,
    },
  );

  globalThis.setTimeout(() => childProcess.exit(), 20);
  await close;
  assert.equal(evaluateCalls, 0);
});

test("Electron close does not mistake Page closure for process exit", async () => {
  const childProcess = new FakeElectronProcess();
  await assert.rejects(
    closeElectronAppWithDiagnostics(
      {
        process: () => childProcess,
        close: pendingPromise,
      },
      {
        isClosed: () => true,
        evaluate: () => {
          throw new Error("closed Page must not be inspected");
        },
      },
      "restart",
      {
        timeoutMs: 5,
        processExitGraceMs: 5,
        pageDiagnosticsTimeoutMs: 5,
      },
    ),
    (error) => {
      assert.match(error.message, /^restart app close timed out:/);
      assert.match(error.message, /"pageClosed":true/);
      assert.match(error.message, /"pid":1234/);
      assert.match(error.message, /"exitCode":null/);
      return true;
    },
  );
});

test("Electron close can diagnose a startup failure without a Page", async () => {
  const childProcess = new FakeElectronProcess();
  await assert.rejects(
    closeElectronAppWithDiagnostics(
      {
        process: () => childProcess,
        close: pendingPromise,
      },
      null,
      "startup",
      {
        timeoutMs: 5,
        processExitGraceMs: 5,
        pageDiagnosticsTimeoutMs: 5,
      },
    ),
    (error) => {
      assert.match(error.message, /^startup app close timed out:/);
      assert.match(error.message, /"pageUnavailable":true/);
      return true;
    },
  );
});
