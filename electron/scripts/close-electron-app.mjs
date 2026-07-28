const APP_CLOSE_TIMEOUT_MS = 20_000;
const PROCESS_EXIT_GRACE_MS = 1_000;
const PAGE_DIAGNOSTICS_TIMEOUT_MS = 2_000;

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
  const promise = new Promise((resolve) => {
    onExit = () => resolve({ kind: "process-exited" });
    childProcess.once("exit", onExit);
  });
  return {
    promise,
    dispose() {
      if (onExit) childProcess.off("exit", onExit);
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
  if (page.isClosed()) return { pageClosed: true };

  const inspection = page
    .evaluate(() => ({
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
      alerts: Array.from(globalThis.document.querySelectorAll('[role="alert"]'))
        .map((element) => element.textContent?.trim() ?? "")
        .filter(Boolean)
        .slice(0, 5),
      quiescenceMarks: globalThis.performance
        .getEntriesByType("mark")
        .map((entry) => entry.name)
        .filter((name) => name.startsWith("grimodex.quiescence."))
        .slice(-40),
    }))
    .catch((error) => ({
      pageClosed: page.isClosed(),
      pageInspectionError:
        error instanceof Error ? error.message : String(error),
    }));
  const timeout = timeoutOutcome(timeoutMs, "page-inspection-timeout");
  try {
    const result = await Promise.race([inspection, timeout.promise]);
    return result.kind === "page-inspection-timeout"
      ? {
          pageClosed: page.isClosed(),
          pageInspectionError: `timed out after ${timeoutMs}ms`,
        }
      : result;
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
  } = {},
) {
  const childProcess = app.process();
  const processExit = observeProcessExit(childProcess);
  const closeTimeout = timeoutOutcome(timeoutMs, "close-timeout");
  const closeOutcome = Promise.resolve()
    .then(() => app.close())
    .then(
      () => ({ kind: "playwright-closed" }),
      (error) => ({ kind: "playwright-close-error", error }),
    );

  try {
    const outcome = await Promise.race([
      closeOutcome,
      processExit.promise,
      closeTimeout.promise,
    ]);
    if (
      outcome.kind === "playwright-closed" ||
      outcome.kind === "process-exited"
    ) {
      return;
    }
    if (outcome.kind === "playwright-close-error") {
      if (processHasExited(childProcess)) return;
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
    closeTimeout.dispose();
    processExit.dispose();
  }
}
