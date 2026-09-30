const APP_CLOSE_TIMEOUT_MS = 20_000;
const PROCESS_EXIT_GRACE_MS = 1_000;
const PAGE_DIAGNOSTICS_TIMEOUT_MS = 2_000;
const QUIESCENCE_DIAGNOSTICS_GLOBAL_KEY = "__grimodexQuiescenceDiagnostics";
export const MAX_QUIESCENCE_DIAGNOSTICS = 16;

const POST_EXIT_CLOSE_ERROR_METADATA = new WeakMap();
const PLAYWRIGHT_POST_EXIT_DISPOSAL_MESSAGE =
  "Cannot read properties of undefined (reading '_object')";

class ElectronPostExitCloseError extends Error {
  constructor({ app, phase, childProcess, cause }) {
    const causeMessage =
      cause instanceof Error ? cause.message : String(cause ?? "unknown error");
    super(`${phase} app close failed after process exit: ${causeMessage}`, {
      cause,
    });
    this.name = "ElectronPostExitCloseError";
    this.app = app;
    this.phase = phase;
    this.childProcess = childProcess;
    POST_EXIT_CLOSE_ERROR_METADATA.set(
      this,
      Object.freeze({ app, phase, childProcess }),
    );
    Object.freeze(this);
  }
}

export function isElectronPostExitCloseError(error, app, phase, childProcess) {
  const metadata = POST_EXIT_CLOSE_ERROR_METADATA.get(error);
  return Boolean(
    metadata &&
    metadata.app === app &&
    metadata.phase === phase &&
    metadata.childProcess === childProcess,
  );
}

function isPlaywrightPostExitDisposalError(error) {
  return (
    error instanceof TypeError &&
    error.name === "TypeError" &&
    error.message === PLAYWRIGHT_POST_EXIT_DISPOSAL_MESSAGE
  );
}

const SAFE_CLOSE_PHASES = new Set([
  "authority-quiescence",
  "genesis-prelude",
  "strict-quiescence",
  "native-close",
]);
const SAFE_QUIESCENCE_STAGES = new Set([
  "ai-executions",
  "autosave",
  "participants",
  "external-write-back",
  "editor-writes",
  "scoped-mutations",
  "scene-writes",
  "unresolved-editor",
  "timelapse",
  "ipc-actual-tasks",
]);
const SAFE_ERROR_NAMES = new Set([
  "AggregateError",
  "Error",
  "EvalError",
  "IpcInvokeError",
  "QuiescenceProviderStageError",
  "RangeError",
  "ReferenceError",
  "StrictQuiescenceError",
  "SyntaxError",
  "TimelapseGenesisBarrierError",
  "TypeError",
  "URIError",
  "UnknownError",
]);
const SAFE_IPC_CODES = new Set([
  "IPC_BACKEND_UNAVAILABLE",
  "IPC_DERIVED_CANCELLED",
  "IPC_MUTATION_CANCELLED",
  "IPC_READ_CANCELLED",
  "IPC_SECRETS_UNAVAILABLE",
  "IPC_TIMEOUT",
  "IPC_UNIMPLEMENTED",
  "NO_WORKSPACE_OPEN",
  "RERANKER_BUSY",
  "UNKNOWN",
  "WORKSPACE_SWITCHING",
]);
const SAFE_OUTCOMES = new Set(["failed", "unknown"]);
const SAFE_PROVIDER_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

function readOwnDataProperty(value, key) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function hasSafeValue(allowlist, value) {
  return typeof value === "string" && allowlist.has(value);
}

function projectQuiescenceDiagnostic(value) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return null;
  }

  const closePhase = readOwnDataProperty(value, "closePhase");
  const errorName = readOwnDataProperty(value, "errorName");
  if (
    !hasSafeValue(SAFE_CLOSE_PHASES, closePhase) ||
    !hasSafeValue(SAFE_ERROR_NAMES, errorName)
  ) {
    return null;
  }

  const projected = { closePhase, errorName };
  const stage = readOwnDataProperty(value, "stage");
  if (hasSafeValue(SAFE_QUIESCENCE_STAGES, stage)) {
    projected.stage = stage;
  }

  const providerId = readOwnDataProperty(value, "providerId");
  if (
    typeof providerId === "string" &&
    SAFE_PROVIDER_ID_PATTERN.test(providerId)
  ) {
    projected.providerId = providerId;
  }

  const ipcCode = readOwnDataProperty(value, "ipcCode");
  if (hasSafeValue(SAFE_IPC_CODES, ipcCode)) {
    projected.ipcCode = ipcCode;
  }

  const outcome = readOwnDataProperty(value, "outcome");
  if (hasSafeValue(SAFE_OUTCOMES, outcome)) {
    projected.outcome = outcome;
  }

  return projected;
}

export function sanitizeQuiescenceDiagnostics(value) {
  try {
    if (!Array.isArray(value)) return [];
    const length = readOwnDataProperty(value, "length");
    if (!Number.isSafeInteger(length) || length < 0) return [];

    const projected = [];
    const count = Math.min(length, MAX_QUIESCENCE_DIAGNOSTICS);
    for (let index = 0; index < count; index += 1) {
      const diagnostic = projectQuiescenceDiagnostic(
        readOwnDataProperty(value, String(index)),
      );
      if (diagnostic !== null) projected.push(diagnostic);
    }
    return projected;
  } catch {
    return [];
  }
}

function safePageInspectionError(error) {
  try {
    if (!(error instanceof Error)) return "UnknownError";
    const name = error.name;
    return hasSafeValue(SAFE_ERROR_NAMES, name) ? name : "Error";
  } catch {
    return "UnknownError";
  }
}

function copyBoundedStringArray(value, maxItems) {
  try {
    if (!Array.isArray(value)) return [];
    const length = readOwnDataProperty(value, "length");
    if (!Number.isSafeInteger(length) || length < 0) return [];

    const copied = [];
    const count = Math.min(length, maxItems);
    for (let index = 0; index < count; index += 1) {
      const item = readOwnDataProperty(value, String(index));
      if (typeof item === "string") copied.push(item);
    }
    return copied;
  } catch {
    return [];
  }
}

function normalizePageDiagnostics(value, timeoutMs) {
  const normalized = {
    quiescenceDiagnostics: sanitizeQuiescenceDiagnostics(
      readOwnDataProperty(value, "quiescenceDiagnostics"),
    ),
  };
  const booleanKeys = [
    "pageClosed",
    "closeFailureDialog",
    "beforeUnloadVetoed",
  ];
  for (const key of booleanKeys) {
    const candidate = readOwnDataProperty(value, key);
    if (typeof candidate === "boolean") normalized[key] = candidate;
  }

  const alerts = readOwnDataProperty(value, "alerts");
  if (alerts !== undefined) {
    normalized.alerts = copyBoundedStringArray(alerts, 5);
  }
  const quiescenceMarks = readOwnDataProperty(value, "quiescenceMarks");
  if (quiescenceMarks !== undefined) {
    normalized.quiescenceMarks = copyBoundedStringArray(quiescenceMarks, 40);
  }

  const pageInspectionError = readOwnDataProperty(value, "pageInspectionError");
  if (typeof pageInspectionError === "string") {
    const timeoutMessage = `timed out after ${timeoutMs}ms`;
    normalized.pageInspectionError =
      pageInspectionError === timeoutMessage
        ? timeoutMessage
        : "page inspection failed";
  }

  const pageUnavailable = readOwnDataProperty(value, "pageUnavailable");
  if (pageUnavailable === true) normalized.pageUnavailable = true;
  return normalized;
}

function processSnapshot(childProcess) {
  if (!childProcess) {
    return {
      pid: null,
      exitCode: null,
      signalCode: null,
      killed: null,
    };
  }
  return {
    pid: childProcess.pid ?? null,
    exitCode: childProcess.exitCode ?? null,
    signalCode: childProcess.signalCode ?? null,
    killed: childProcess.killed ?? false,
  };
}

function validateChildProcess(childProcess, phase) {
  if (
    childProcess === null ||
    typeof childProcess !== "object" ||
    Array.isArray(childProcess)
  ) {
    throw new TypeError(
      `electron close received an invalid child process for ${phase}`,
    );
  }

  let hasPid;
  let pid;
  let once;
  let removeListener;
  let kill;
  let exitCode;
  let signalCode;
  try {
    hasPid = Object.prototype.hasOwnProperty.call(childProcess, "pid");
    pid = childProcess.pid;
    once = childProcess.once;
    removeListener = childProcess.removeListener;
    kill = childProcess.kill;
    exitCode = childProcess.exitCode;
    signalCode = childProcess.signalCode;
  } catch (error) {
    throw new TypeError(
      `electron close could not inspect the child process for ${phase}`,
      { cause: error },
    );
  }
  if (
    !hasPid ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof once !== "function" ||
    typeof removeListener !== "function" ||
    typeof kill !== "function" ||
    !(exitCode === null || Number.isInteger(exitCode)) ||
    !(signalCode === null || typeof signalCode === "string")
  ) {
    throw new TypeError(
      `electron close received a malformed child process for ${phase}`,
    );
  }
  return childProcess;
}

function processHasExited(childProcess) {
  return Boolean(
    childProcess &&
    (childProcess.exitCode !== null || childProcess.signalCode !== null),
  );
}

function observeProcessExit(childProcess) {
  if (!childProcess) {
    return {
      promise: new Promise(() => {}),
      dispose() {},
    };
  }
  if (processHasExited(childProcess)) {
    return {
      promise: Promise.resolve({ kind: "process-exited" }),
      dispose() {},
    };
  }

  let onExit;
  let resolveExit;
  const promise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  onExit = () => resolveExit({ kind: "process-exited" });
  try {
    childProcess.once("exit", onExit);
  } catch (error) {
    try {
      childProcess.removeListener("exit", onExit);
    } catch {
      // Preserve the event subscription failure as the actionable error.
    }
    throw error;
  }
  return {
    promise,
    dispose() {
      if (onExit) childProcess.removeListener("exit", onExit);
    },
  };
}

function timeoutOutcome(timeoutMs, kind) {
  let timeoutId;
  return {
    promise: new Promise((resolve) => {
      timeoutId = globalThis.setTimeout(() => resolve({ kind }), timeoutMs);
    }),
    dispose() {
      if (timeoutId) globalThis.clearTimeout(timeoutId);
    },
  };
}

async function collectPageDiagnostics(page, timeoutMs) {
  if (!page) {
    return { pageUnavailable: true, quiescenceDiagnostics: [] };
  }
  if (page.isClosed()) {
    return { pageClosed: true, quiescenceDiagnostics: [] };
  }

  const inspection = page
    .evaluate(() => {
      const MAX_RECORDS = 16;
      const GLOBAL_KEY = "__grimodexQuiescenceDiagnostics";
      const CLOSE_PHASES = new Set([
        "authority-quiescence",
        "genesis-prelude",
        "strict-quiescence",
        "native-close",
      ]);
      const STAGES = new Set([
        "ai-executions",
        "autosave",
        "participants",
        "external-write-back",
        "editor-writes",
        "scoped-mutations",
        "scene-writes",
        "unresolved-editor",
        "timelapse",
        "ipc-actual-tasks",
      ]);
      const ERROR_NAMES = new Set([
        "AggregateError",
        "Error",
        "EvalError",
        "IpcInvokeError",
        "QuiescenceProviderStageError",
        "RangeError",
        "ReferenceError",
        "StrictQuiescenceError",
        "SyntaxError",
        "TimelapseGenesisBarrierError",
        "TypeError",
        "URIError",
        "UnknownError",
      ]);
      const IPC_CODES = new Set([
        "IPC_BACKEND_UNAVAILABLE",
        "IPC_DERIVED_CANCELLED",
        "IPC_MUTATION_CANCELLED",
        "IPC_READ_CANCELLED",
        "IPC_SECRETS_UNAVAILABLE",
        "IPC_TIMEOUT",
        "IPC_UNIMPLEMENTED",
        "NO_WORKSPACE_OPEN",
        "RERANKER_BUSY",
        "UNKNOWN",
        "WORKSPACE_SWITCHING",
      ]);
      const OUTCOMES = new Set(["failed", "unknown"]);
      const PROVIDER_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

      const readOwn = (value, key) => {
        if (
          value === null ||
          (typeof value !== "object" && typeof value !== "function")
        ) {
          return undefined;
        }
        try {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          return descriptor && "value" in descriptor
            ? descriptor.value
            : undefined;
        } catch {
          return undefined;
        }
      };
      const isAllowed = (allowlist, value) =>
        typeof value === "string" && allowlist.has(value);
      const project = (value) => {
        if (
          value === null ||
          (typeof value !== "object" && typeof value !== "function")
        ) {
          return null;
        }
        const closePhase = readOwn(value, "closePhase");
        const errorName = readOwn(value, "errorName");
        if (
          !isAllowed(CLOSE_PHASES, closePhase) ||
          !isAllowed(ERROR_NAMES, errorName)
        ) {
          return null;
        }
        const projected = { closePhase, errorName };
        const stage = readOwn(value, "stage");
        if (isAllowed(STAGES, stage)) projected.stage = stage;
        const providerId = readOwn(value, "providerId");
        if (
          typeof providerId === "string" &&
          PROVIDER_ID_PATTERN.test(providerId)
        ) {
          projected.providerId = providerId;
        }
        const ipcCode = readOwn(value, "ipcCode");
        if (isAllowed(IPC_CODES, ipcCode)) projected.ipcCode = ipcCode;
        const outcome = readOwn(value, "outcome");
        if (isAllowed(OUTCOMES, outcome)) projected.outcome = outcome;
        return projected;
      };

      let diagnostics;
      try {
        const globalDescriptor = Object.getOwnPropertyDescriptor(
          globalThis,
          GLOBAL_KEY,
        );
        diagnostics =
          globalDescriptor && "value" in globalDescriptor
            ? globalDescriptor.value
            : undefined;
        if (!Array.isArray(diagnostics)) {
          diagnostics = [];
        }
      } catch {
        diagnostics = [];
      }

      const projectedDiagnostics = [];
      try {
        const length = readOwn(diagnostics, "length");
        if (Number.isSafeInteger(length) && length >= 0) {
          const count = Math.min(length, MAX_RECORDS);
          for (let index = 0; index < count; index += 1) {
            const projected = project(readOwn(diagnostics, String(index)));
            if (projected !== null) projectedDiagnostics.push(projected);
          }
        }
      } catch {
        return [];
      }

      return {
        pageClosed: false,
        closeFailureDialog: Boolean(
          globalThis.document.querySelector(
            '[data-testid="close-save-failure-dialog"]',
          ),
        ),
        beforeUnloadVetoed: (() => {
          const event = new globalThis.Event("beforeunload", {
            cancelable: true,
          });
          globalThis.window.dispatchEvent(event);
          return event.defaultPrevented;
        })(),
        alerts: Array.from(
          globalThis.document.querySelectorAll('[role="alert"]'),
        )
          .map((element) => element.textContent?.trim() ?? "")
          .filter(Boolean)
          .slice(0, 5),
        quiescenceMarks: globalThis.performance
          .getEntriesByType("mark")
          .map((entry) => entry.name)
          .filter((name) => name.startsWith("grimodex.quiescence."))
          .slice(-40),
        quiescenceDiagnostics: projectedDiagnostics,
      };
    })
    .catch((error) => ({
      pageClosed: page.isClosed(),
      pageInspectionError: safePageInspectionError(error),
      quiescenceDiagnostics: [],
    }));
  const timeout = timeoutOutcome(timeoutMs, "page-inspection-timeout");
  try {
    const result = await Promise.race([inspection, timeout.promise]);
    return result.kind === "page-inspection-timeout"
      ? {
          pageClosed: page.isClosed(),
          pageInspectionError: `timed out after ${timeoutMs}ms`,
          quiescenceDiagnostics: [],
        }
      : normalizePageDiagnostics(result, timeoutMs);
  } finally {
    timeout.dispose();
  }
}

export async function closeElectronAppWithDiagnostics(
  app,
  page,
  phase,
  {
    timeoutMs = APP_CLOSE_TIMEOUT_MS,
    processExitGraceMs = PROCESS_EXIT_GRACE_MS,
    pageDiagnosticsTimeoutMs = PAGE_DIAGNOSTICS_TIMEOUT_MS,
    childProcess: capturedChildProcess = undefined,
    skipProcessLookup = false,
    throwOnPostExitCloseError = false,
  } = {},
) {
  let childProcess;
  let processExit;
  let closeTimeout;
  let closeOutcome;
  try {
    childProcess = skipProcessLookup
      ? capturedChildProcess
      : (capturedChildProcess ?? app.process());
    if (childProcess === null || childProcess === undefined) {
      if (!skipProcessLookup) {
        validateChildProcess(childProcess, phase);
      }
    } else {
      validateChildProcess(childProcess, phase);
    }
    processExit = observeProcessExit(childProcess);
    closeTimeout = timeoutOutcome(timeoutMs, "close-timeout");
    closeOutcome = Promise.resolve()
      .then(() => app.close())
      .then(
        () => ({ kind: "playwright-closed" }),
        (error) => ({ kind: "playwright-close-error", error }),
      );

    if (throwOnPostExitCloseError) {
      const outcome = await Promise.race([closeOutcome, closeTimeout.promise]);
      if (outcome.kind === "playwright-close-error") {
        if (
          processHasExited(childProcess) &&
          isPlaywrightPostExitDisposalError(outcome.error)
        ) {
          throw new ElectronPostExitCloseError({
            app,
            phase,
            childProcess,
            cause: outcome.error,
          });
        }
        throw new Error(
          `${phase} app close failed: ${
            outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error)
          }`,
          { cause: outcome.error },
        );
      }
      if (outcome.kind === "close-timeout") {
        const pageDiagnostics = await collectPageDiagnostics(
          page,
          pageDiagnosticsTimeoutMs,
        );
        throw new Error(
          `${phase} app close timed out: ${JSON.stringify({
            ...pageDiagnostics,
            process: processSnapshot(childProcess),
          })}`,
        );
      }
      if (processHasExited(childProcess)) return;
      const exitGrace = timeoutOutcome(
        processExitGraceMs,
        "exit-grace-timeout",
      );
      try {
        const graceOutcome = await Promise.race([
          processExit.promise,
          exitGrace.promise,
        ]);
        if (graceOutcome.kind === "process-exited") return;
      } finally {
        exitGrace.dispose();
      }
      const pageDiagnostics = await collectPageDiagnostics(
        page,
        pageDiagnosticsTimeoutMs,
      );
      throw new Error(
        `${phase} app close timed out: ${JSON.stringify({
          ...pageDiagnostics,
          process: processSnapshot(childProcess),
        })}`,
      );
    }
    let outcome = await Promise.race([
      closeOutcome,
      processExit.promise,
      closeTimeout.promise,
    ]);
    if (
      outcome.kind === "playwright-closed" &&
      childProcess &&
      !processHasExited(childProcess)
    ) {
      // A repeated Playwright close can resolve while the captured child is
      // still alive. Retain ownership until real exit under the same deadline.
      outcome = await Promise.race([processExit.promise, closeTimeout.promise]);
    }
    if (
      outcome.kind === "playwright-closed" ||
      outcome.kind === "process-exited"
    ) {
      return;
    }
    if (outcome.kind === "playwright-close-error") {
      if (processHasExited(childProcess)) {
        return;
      }
      throw new Error(
        `${phase} app close failed: ${
          outcome.error instanceof Error
            ? outcome.error.message
            : String(outcome.error)
        }`,
        { cause: outcome.error },
      );
    }

    const pageDiagnostics = await collectPageDiagnostics(
      page,
      pageDiagnosticsTimeoutMs,
    );
    if (processHasExited(childProcess)) return;

    // Window teardown and the child-process `exit` event are independent event
    // sources. Give an already-closing process one short settlement window, but
    // never treat Page closure alone as successful application shutdown.
    const exitGrace = timeoutOutcome(processExitGraceMs, "exit-grace-timeout");
    try {
      const graceOutcome = await Promise.race([
        processExit.promise,
        exitGrace.promise,
      ]);
      if (graceOutcome.kind === "process-exited") return;
    } finally {
      exitGrace.dispose();
    }

    throw new Error(
      `${phase} app close timed out: ${JSON.stringify({
        ...pageDiagnostics,
        process: processSnapshot(childProcess),
      })}`,
    );
  } finally {
    closeTimeout?.dispose();
    processExit?.dispose();
  }
}
