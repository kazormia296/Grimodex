/* global clearTimeout, document, performance, requestAnimationFrame, setTimeout, window */

import { spawnSync as defaultSpawnSync } from "node:child_process";
import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const RUNTIME_PERFORMANCE_XVFB_COMMAND = "xvfb-run";
export const RUNTIME_PERFORMANCE_XVFB_ARGS = Object.freeze([
  "--auto-servernum",
  "--server-args=-screen 0 1920x1080x24",
]);
export const RUNTIME_PERFORMANCE_RAF_CALIBRATION_SAMPLE_COUNT = 16;

const RUNTIME_ENVIRONMENT_KEYS = Object.freeze([
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "ELECTRON_OZONE_PLATFORM_HINT",
  "GDK_BACKEND",
  "QT_QPA_PLATFORM",
]);

function serializeError(error) {
  if (error == null) return null;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    };
  }
  return { name: "Error", message: String(error), stack: null };
}

function cloneJson(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return { serializationError: serializeError(error) };
  }
}

function quantile(values, probability) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * probability) - 1),
  );
  return sorted[index];
}

export function buildRuntimePerformanceSmokeInvocation({
  platform = process.platform,
  nodePath = process.execPath,
  smokePath,
  xvfbCommand = RUNTIME_PERFORMANCE_XVFB_COMMAND,
  xvfbArgs = RUNTIME_PERFORMANCE_XVFB_ARGS,
} = {}) {
  if (platform === "linux") {
    return {
      useFreshXvfb: true,
      command: xvfbCommand,
      args: [...xvfbArgs, nodePath, smokePath],
    };
  }
  return {
    useFreshXvfb: false,
    command: nodePath,
    args: [smokePath],
  };
}

export function checkFreshXvfbCapability({
  platform = process.platform,
  command = RUNTIME_PERFORMANCE_XVFB_COMMAND,
  spawnSyncImpl,
} = {}) {
  if (platform !== "linux") {
    return { required: false, available: true, command: null };
  }
  const spawn = spawnSyncImpl ?? (() => null);
  try {
    const result = spawn(command, ["--help"], { stdio: "ignore" });
    if (result?.status === 0 && !result.error) {
      return { required: true, available: true, command };
    }
    const reason = result?.error?.message
      ? result.error.message
      : `exit status ${String(result?.status ?? "unknown")}`;
    return { required: true, available: false, command, reason };
  } catch (error) {
    return {
      required: true,
      available: false,
      command,
      reason: serializeError(error).message,
    };
  }
}

export function buildRuntimePerformanceTimeoutArtifactPath(filePath) {
  const absolutePath = path.resolve(filePath);
  const extension = path.extname(absolutePath);
  const stem = extension
    ? absolutePath.slice(0, -extension.length)
    : absolutePath;
  return `${stem}-timeout${extension || ".json"}`;
}

export function snapshotRuntimeEnvironment(environment = process.env) {
  return Object.fromEntries(
    RUNTIME_ENVIRONMENT_KEYS.map((key) => [key, environment[key] ?? null]),
  );
}

export function snapshotChildProcess(childProcess) {
  if (!childProcess) return null;
  return {
    pid: childProcess.pid ?? null,
    exitCode: childProcess.exitCode ?? null,
    signalCode: childProcess.signalCode ?? null,
    killed: childProcess.killed ?? null,
  };
}

export function snapshotNodeProcess(nodeProcess = process) {
  return {
    pid: nodeProcess.pid ?? null,
    ppid: nodeProcess.ppid ?? null,
    platform: nodeProcess.platform ?? null,
    execPath: nodeProcess.execPath ?? null,
    argv: Array.isArray(nodeProcess.argv) ? [...nodeProcess.argv] : null,
    version: nodeProcess.version ?? null,
  };
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Coordinate cleanup by owned resource identity. The public object is frozen;
 * its private promises are deliberately shared by normal and timeout paths so
 * a watchdog racing a phase finally cannot close or stop the same handle twice.
 */
export function createRuntimePerformanceCleanupCoordinator() {
  let memoryStopPromise = null;
  let closePromise = null;
  let terminationPromise = null;

  return Object.freeze({
    get memoryStopPromise() {
      return memoryStopPromise;
    },
    get closePromise() {
      return closePromise;
    },
    get terminationPromise() {
      return terminationPromise;
    },
    snapshot() {
      return deepFreeze({
        memoryStopStarted: memoryStopPromise !== null,
        closeStarted: closePromise !== null,
        terminationStarted: terminationPromise !== null,
      });
    },
    stopMemorySampler(memorySampler) {
      if (!memorySampler?.stop) return Promise.resolve(null);
      if (!memoryStopPromise) {
        memoryStopPromise = Promise.resolve().then(() => memorySampler.stop());
      }
      return memoryStopPromise;
    },
    closeApp(app, page, phase, closeFn) {
      if (!app || typeof closeFn !== "function") return Promise.resolve(null);
      if (!closePromise) {
        closePromise = Promise.resolve().then(() => closeFn(app, page, phase));
      }
      return closePromise;
    },
    terminateProcess(terminateFn) {
      if (typeof terminateFn !== "function") {
        return Promise.resolve({ status: "skipped", reason: "no-killer" });
      }
      if (!terminationPromise) {
        terminationPromise = Promise.resolve().then(terminateFn);
      }
      return terminationPromise;
    },
  });
}

export function snapshotRuntimePerformanceContext(
  context = {},
  {
    now = () => Date.now(),
    monotonicNow = () => globalThis.performance?.now?.() ?? null,
    nodeProcess = process,
    environment = process.env,
  } = {},
) {
  const nowValue = typeof now === "function" ? now() : now;
  const monotonicValue =
    typeof monotonicNow === "function" ? monotonicNow() : monotonicNow;
  let childProcess = context.childProcess ?? null;
  let processCaptureError = null;
  if (!childProcess && context.app?.process) {
    try {
      childProcess = context.app.process();
    } catch (error) {
      processCaptureError = serializeError(error);
    }
  }
  const elapsedMs =
    Number.isFinite(Number(context.startedAtMonotonic)) &&
    Number.isFinite(Number(monotonicValue))
      ? Number(monotonicValue) - Number(context.startedAtMonotonic)
      : null;
  const cleanupCoordinator = context.cleanupCoordinator ?? null;
  const snapshot = {
    capturedAt: new Date(nowValue).toISOString(),
    startedAt: context.startedAt ?? null,
    elapsedMs,
    phase: context.phase ?? null,
    currentInteraction: context.currentInteraction ?? null,
    // Resource handles are captured once for the finalizer. They are not
    // traversed after this point; only these exact owned handles are used.
    app: context.app ?? null,
    page: context.page ?? null,
    memorySampler: context.memorySampler ?? null,
    childProcess,
    partialMetrics: cloneJson(context.partialMetrics),
    rafCalibration: cloneJson(context.rafCalibration),
    foreground: cloneJson(context.foreground),
    environment: snapshotRuntimeEnvironment(environment),
    process: {
      node: snapshotNodeProcess(nodeProcess),
      electron: snapshotChildProcess(childProcess),
      captureError: processCaptureError,
    },
    cleanupState: cleanupCoordinator?.snapshot?.() ?? null,
    cleanupCoordinator,
  };
  // Freeze evidence and the resource references themselves. Electron/Playwright
  // handles remain owned by their libraries; no nested handle is mutated here.
  deepFreeze(snapshot.partialMetrics);
  deepFreeze(snapshot.rafCalibration);
  deepFreeze(snapshot.foreground);
  deepFreeze(snapshot.environment);
  deepFreeze(snapshot.process);
  deepFreeze(snapshot.cleanupState);
  return Object.freeze(snapshot);
}

export function assertRuntimePerformanceActive(
  signal,
  label = "runtime performance phase",
) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  const detail =
    reason instanceof Error ? reason.message : String(reason ?? "watchdog");
  throw new Error(`${label} aborted: ${detail}`);
}

export async function runRuntimePerformancePhaseSequence({
  signal,
  phases = [],
} = {}) {
  for (const [index, phase] of phases.entries()) {
    assertRuntimePerformanceActive(signal, `phase ${index + 1}`);
    if (typeof phase !== "function") {
      throw new TypeError(`phase ${index + 1} is not callable`);
    }
    await phase();
  }
}

function normalizePid(pid) {
  const number = Number(pid);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function parseOwnedProcessTable(output) {
  if (Array.isArray(output)) return output;
  return String(output ?? "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)(?:\s|$)/);
      if (!match) return null;
      return { pid: Number(match[1]), ppid: Number(match[2]) };
    })
    .filter(Boolean);
}

export function collectOwnedProcessTree(rootPid, processTable = []) {
  const normalizedRootPid = normalizePid(rootPid);
  if (normalizedRootPid === null) return [];
  const childrenByParent = new Map();
  for (const row of parseOwnedProcessTable(processTable)) {
    const pid = normalizePid(row?.pid);
    const ppid = normalizePid(row?.ppid);
    if (pid === null || ppid === null) continue;
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  for (const children of childrenByParent.values())
    children.sort((a, b) => a - b);

  const visited = new Set();
  const owned = [];
  const visit = (pid) => {
    if (visited.has(pid)) return;
    visited.add(pid);
    for (const childPid of childrenByParent.get(pid) ?? []) visit(childPid);
    owned.push(pid);
  };
  visit(normalizedRootPid);
  return owned;
}

function isAlreadyExitedError(error) {
  return error?.code === "ESRCH" || error?.errno === "ESRCH";
}

function isCommandUnavailableError(error) {
  return (
    error?.code === "ENOENT" ||
    /\bENOENT\b/.test(String(error?.message ?? error))
  );
}

function terminationError(stage, pid, signal, error) {
  return {
    stage,
    ...(pid === undefined ? {} : { pid }),
    ...(signal ? { signal } : {}),
    ...serializeError(error),
  };
}

/**
 * Terminate only the Electron child PID captured at timeout and descendants
 * observed from an explicit process table. No command-line pattern matching is
 * used, so unrelated main.cjs siblings remain untouched.
 */
export async function terminateOwnedProcessTree({
  childProcessSnapshot = null,
  pid: requestedPid = null,
  platform = process.platform,
  processTable,
  spawnSyncImpl = defaultSpawnSync,
  killImpl = (targetPid, signal) => process.kill(targetPid, signal),
  timeoutMs = 1_000,
} = {}) {
  const rootPid = normalizePid(requestedPid ?? childProcessSnapshot?.pid);
  if (rootPid === null) {
    return {
      status: "skipped",
      reason: "owned-pid-unavailable",
      platform,
      pids: [],
      errors: [],
      boundedTimeoutMs: timeoutMs,
    };
  }
  if (rootPid === process.pid) {
    return {
      status: "failed",
      reason: "refusing-to-kill-current-process",
      platform,
      pids: [rootPid],
      errors: [
        terminationError(
          "safety-check",
          rootPid,
          null,
          new Error("owned PID equals watchdog process PID"),
        ),
      ],
      boundedTimeoutMs: timeoutMs,
    };
  }

  if (platform === "win32") {
    try {
      const result = spawnSyncImpl(
        "taskkill",
        ["/PID", String(rootPid), "/T", "/F"],
        { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
      );
      if (isCommandUnavailableError(result?.error)) {
        return {
          status: "unavailable",
          reason: "taskkill unavailable: ENOENT",
          platform,
          pids: [rootPid],
          errors: [terminationError("taskkill", rootPid, null, result.error)],
          boundedTimeoutMs: timeoutMs,
        };
      }
      if (result?.status === 0 && !result?.error) {
        return {
          status: "completed",
          platform,
          killer: "taskkill",
          pids: [rootPid],
          errors: [],
          boundedTimeoutMs: timeoutMs,
        };
      }
      return {
        status: "failed",
        reason:
          result?.error?.message ?? `taskkill exit ${String(result?.status)}`,
        platform,
        killer: "taskkill",
        pids: [rootPid],
        errors: result?.error
          ? [terminationError("taskkill", rootPid, null, result.error)]
          : [],
        boundedTimeoutMs: timeoutMs,
      };
    } catch (error) {
      const unavailable = isCommandUnavailableError(error);
      return {
        status: unavailable ? "unavailable" : "failed",
        reason: unavailable
          ? "taskkill unavailable: ENOENT"
          : String(error?.message ?? error),
        platform,
        killer: "taskkill",
        pids: [rootPid],
        errors: [terminationError("taskkill", rootPid, null, error)],
        boundedTimeoutMs: timeoutMs,
      };
    }
  }

  let table = processTable;
  let processTableError = null;
  if (table === undefined) {
    try {
      const result = spawnSyncImpl("ps", ["-eo", "pid=,ppid="], {
        encoding: "utf8",
        timeout: timeoutMs,
      });
      table = result?.stdout ?? "";
      if (result?.error) processTableError = result.error;
    } catch (error) {
      processTableError = error;
      table = "";
    }
  }
  const pids = collectOwnedProcessTree(rootPid, table);
  const errors = processTableError
    ? [terminationError("process-tree", rootPid, null, processTableError)]
    : [];
  const signals = [];
  for (const targetPid of pids) {
    if (targetPid === process.pid) {
      errors.push(
        terminationError(
          "safety-check",
          targetPid,
          null,
          new Error("refusing to kill watchdog process"),
        ),
      );
      continue;
    }
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      try {
        killImpl(targetPid, signal);
        signals.push({ pid: targetPid, signal, status: "sent" });
      } catch (error) {
        if (isAlreadyExitedError(error)) {
          signals.push({ pid: targetPid, signal, status: "already-exited" });
          break;
        }
        errors.push(terminationError("kill", targetPid, signal, error));
        break;
      }
    }
  }
  return {
    status: errors.length > 0 ? "failed" : "completed",
    platform,
    killer: "process.kill",
    pids,
    signals,
    errors,
    boundedTimeoutMs: timeoutMs,
  };
}

export function summarizeRafCalibration(
  samples,
  requestedSampleCount = RUNTIME_PERFORMANCE_RAF_CALIBRATION_SAMPLE_COUNT,
  error = null,
) {
  const safeSamples = Array.isArray(samples) ? samples.map(cloneJson) : [];
  const timestamps = safeSamples
    .map((sample) => Number(sample?.timestamp))
    .filter(Number.isFinite);
  const intervals = timestamps
    .slice(1)
    .map((timestamp, index) => timestamp - timestamps[index]);
  const finiteIntervals = intervals.filter(Number.isFinite);
  const total = finiteIntervals.reduce((sum, value) => sum + value, 0);
  return {
    requestedSampleCount,
    sampleCount: safeSamples.length,
    complete: safeSamples.length >= requestedSampleCount && error == null,
    samples: safeSamples,
    intervals: finiteIntervals,
    p50Ms: quantile(finiteIntervals, 0.5),
    p95Ms: quantile(finiteIntervals, 0.95),
    meanMs: finiteIntervals.length > 0 ? total / finiteIntervals.length : null,
    maxMs: finiteIntervals.length > 0 ? Math.max(...finiteIntervals) : null,
    error: error ? serializeError(error) : null,
  };
}

export async function captureRafCalibration(
  page,
  {
    sampleCount = RUNTIME_PERFORMANCE_RAF_CALIBRATION_SAMPLE_COUNT,
    onSample = () => {},
  } = {},
) {
  const samples = [];
  let failure = null;
  for (let index = 0; index < sampleCount; index += 1) {
    try {
      const sample = await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame((timestamp) =>
              resolve({
                timestamp,
                callbackNow: performance.now(),
                visibilityState: document.visibilityState,
                documentHidden: document.hidden,
                documentHasFocus: document.hasFocus(),
              }),
            ),
          ),
      );
      if (!sample || !Number.isFinite(Number(sample.timestamp))) {
        throw new Error("rAF calibration returned an invalid timestamp");
      }
      samples.push(sample);
      await onSample(summarizeRafCalibration(samples, sampleCount));
    } catch (error) {
      failure = error;
      break;
    }
  }
  return summarizeRafCalibration(samples, sampleCount, failure);
}

export async function readRuntimeWindowSnapshot(app) {
  if (!app?.evaluate) {
    return { available: false, reason: "electron-app-unavailable" };
  }
  return await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow?.getAllWindows?.() ?? [];
    const window = windows.find((candidate) => !candidate.isDestroyed?.());
    if (!window) {
      return { available: false, reason: "no-live-browser-window" };
    }
    return {
      available: true,
      id: window.id ?? null,
      webContentsId: window.webContents?.id ?? null,
      bounds: window.getBounds?.() ?? null,
      isFocused: window.isFocused?.() ?? null,
      isVisible: window.isVisible?.() ?? null,
      isMinimized: window.isMinimized?.() ?? null,
    };
  });
}

export async function focusRuntimeWindow(app) {
  if (!app?.evaluate) {
    return { available: false, reason: "electron-app-unavailable" };
  }
  return await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow?.getAllWindows?.() ?? [];
    const window = windows.find((candidate) => !candidate.isDestroyed?.());
    if (!window) {
      return { available: false, reason: "no-live-browser-window" };
    }
    if (window.isMinimized?.()) window.restore?.();
    if (!window.isVisible?.()) window.show?.();
    window.focus?.();
    return {
      available: true,
      id: window.id ?? null,
      webContentsId: window.webContents?.id ?? null,
      bounds: window.getBounds?.() ?? null,
      isFocused: window.isFocused?.() ?? null,
      isVisible: window.isVisible?.() ?? null,
      isMinimized: window.isMinimized?.() ?? null,
    };
  });
}

export async function readDomForegroundSnapshot(page) {
  if (!page?.evaluate) {
    return { available: false, reason: "page-unavailable" };
  }
  return await page.evaluate(() => ({
    available: true,
    visibilityState: document.visibilityState,
    documentHidden: document.hidden,
    documentHasFocus: document.hasFocus(),
    hasFocus: document.hasFocus(),
    activeElementTagName: document.activeElement?.tagName ?? null,
    activeElementTestId:
      document.activeElement?.getAttribute?.("data-testid") ?? null,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  }));
}

export function buildRuntimePerformanceTimeoutArtifact({
  reason = "global-watchdog",
  timeoutMs = null,
  startedAt = new Date().toISOString(),
  timedOutAt = new Date().toISOString(),
  elapsedMs = null,
  phase = null,
  currentInteraction = null,
  partialMetrics = null,
  rafCalibration = null,
  foreground = null,
  nativeWindow = foreground?.nativeWindow ?? null,
  environment = snapshotRuntimeEnvironment(),
  process: processSnapshot = snapshotNodeProcess(),
  diagnostics = null,
  cleanup = null,
} = {}) {
  return {
    schemaVersion: 1,
    kind: "electron-runtime-performance-timeout",
    reason,
    timeoutMs,
    startedAt,
    timedOutAt,
    elapsedMs,
    phase,
    currentInteraction,
    partialMetrics: cloneJson(partialMetrics),
    rafCalibration: cloneJson(rafCalibration),
    foreground: cloneJson(foreground),
    nativeWindow: cloneJson(nativeWindow),
    environment: cloneJson(environment),
    process: cloneJson(processSnapshot),
    diagnostics: cloneJson(diagnostics),
    cleanup: cloneJson(cleanup),
  };
}

export async function runBoundedOperation(label, operation, timeoutMs) {
  if (typeof operation !== "function") return { status: "skipped" };
  let timer = null;
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
    if (result?.timedOut === true) {
      return { status: "timed-out", label, timeoutMs };
    }
    return {
      status: "completed",
      ...(result === undefined ? {} : { value: cloneJson(result) }),
    };
  } catch (error) {
    return { status: "failed", label, error: serializeError(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeProcessTerminationResult(operationResult) {
  if (
    operationResult?.status === "completed" &&
    operationResult.value &&
    typeof operationResult.value.status === "string"
  ) {
    return {
      ...operationResult.value,
      operationStatus: "completed",
    };
  }
  return operationResult;
}

function cleanupOperationSucceeded(operationResult) {
  return (
    operationResult?.status === "completed" ||
    operationResult?.status === "skipped"
  );
}

function requiredCleanupOperation(label, operation) {
  if (typeof operation === "function") return operation;
  return () => {
    throw new TypeError(
      `${label} cleanup callback is required for an owned resource`,
    );
  };
}

/**
 * Finish one normal smoke phase without allowing a stalled inspector call to
 * strand the phase's `finally` block. The caller owns the resource-specific
 * callbacks so the same cleanup coordinator can deduplicate normal, failure,
 * and watchdog paths.
 */
export async function cleanupRuntimePerformancePhase({
  app = null,
  page = null,
  phase = "runtime phase",
  memorySampler = null,
  cleanupCoordinator = null,
  stopMemorySampler,
  closeApp,
  forceKill,
  operationTimeoutMs = 5_000,
  abort,
} = {}) {
  let abortIssued = false;
  const abortCleanup = (reason) => {
    if (abortIssued || typeof abort !== "function") return;
    abortIssued = true;
    try {
      abort(reason);
    } catch {
      // Cleanup must continue to the owned app/force-kill path even if the
      // caller's abort hook has already been disposed.
    }
  };

  const memoryResult = await runBoundedOperation(
    "memorySampler",
    memorySampler
      ? requiredCleanupOperation("memorySampler", stopMemorySampler)
      : undefined,
    operationTimeoutMs,
  );
  if (!cleanupOperationSucceeded(memoryResult)) {
    abortCleanup(
      memoryResult.status === "timed-out"
        ? "phase-cleanup-timeout"
        : "phase-cleanup-failed",
    );
  }

  const appResult = await runBoundedOperation(
    "app",
    app ? requiredCleanupOperation("app", closeApp) : undefined,
    operationTimeoutMs,
  );
  const closeSucceeded =
    !app ||
    (cleanupOperationSucceeded(appResult) &&
      appResult.value?.closed !== false);
  if (!closeSucceeded) {
    abortCleanup(
      appResult.status === "timed-out"
        ? "phase-cleanup-timeout"
        : "phase-cleanup-failed",
    );
  }

  const forceKillResult = closeSucceeded
    ? { status: "skipped", reason: "close-completed" }
    : normalizeProcessTerminationResult(
        await runBoundedOperation(
          "forceKill",
          requiredCleanupOperation("forceKill", forceKill),
          operationTimeoutMs,
        ),
      );
  if (!closeSucceeded && !cleanupOperationSucceeded(forceKillResult)) {
    abortCleanup(
      forceKillResult.status === "timed-out"
        ? "phase-cleanup-timeout"
        : "phase-cleanup-failed",
    );
  }

  const forceKillSucceeded =
    closeSucceeded || forceKillResult.status === "completed";
  const status =
    cleanupOperationSucceeded(memoryResult) &&
    closeSucceeded &&
    forceKillSucceeded
      ? "completed"
      : "failed";
  return {
    status,
    phase,
    memorySampler: memoryResult,
    app: appResult,
    forceKill: forceKillResult,
    cleanupState: cleanupCoordinator?.snapshot?.() ?? null,
  };
}

export async function finalizeRuntimePerformanceTimeout({
  timeoutArtifactPath,
  artifact,
  collectDiagnostics,
  finalizeSession,
  stopMemorySampler,
  closeApp,
  forceKill,
  writeArtifact = writeRuntimePerformanceTimeoutArtifact,
  operationTimeoutMs = 5_000,
  hardExit,
  exitCode = 1,
} = {}) {
  const diagnosticsResult = await runBoundedOperation(
    "diagnostics",
    collectDiagnostics,
    operationTimeoutMs,
  );
  const sessionResult = await runBoundedOperation(
    "session",
    finalizeSession,
    operationTimeoutMs,
  );
  const memoryResult = await runBoundedOperation(
    "memorySampler",
    stopMemorySampler,
    operationTimeoutMs,
  );
  const appResult = await runBoundedOperation(
    "app",
    closeApp,
    operationTimeoutMs,
  );
  const closeSucceeded =
    appResult.status === "completed" && appResult.value?.closed !== false;
  const killResult = closeSucceeded
    ? {
        status: "skipped",
        reason: "close-completed",
      }
    : normalizeProcessTerminationResult(
        await runBoundedOperation("forceKill", forceKill, operationTimeoutMs),
      );
  const diagnostics =
    diagnosticsResult.status === "completed"
      ? (diagnosticsResult.value ?? null)
      : { status: diagnosticsResult.status, error: diagnosticsResult.error };
  const cleanup = {
    diagnostics: diagnosticsResult,
    session: sessionResult,
    memorySampler: memoryResult,
    app: appResult,
    forceKill: killResult,
    processTermination: killResult,
  };
  const finalArtifact = buildRuntimePerformanceTimeoutArtifact({
    ...artifact,
    diagnostics,
    cleanup,
  });
  const absolutePath = path.resolve(timeoutArtifactPath);
  const writeResult = await runBoundedOperation(
    "writeArtifact",
    () => writeArtifact(absolutePath, finalArtifact),
    operationTimeoutMs,
  );
  const result = {
    path: absolutePath,
    artifact: finalArtifact,
    writeArtifact: writeResult,
  };
  if (typeof hardExit === "function") await hardExit(exitCode, result);
  return result;
}

export async function writeRuntimePerformanceTimeoutArtifact(
  filePath,
  artifact,
) {
  const absolutePath = path.resolve(filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp-${process.pid}`;
  const handle = await open(temporaryPath, "w");
  try {
    await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, absolutePath);
  return absolutePath;
}
