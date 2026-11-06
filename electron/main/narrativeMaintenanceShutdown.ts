/**
 * Main-process owner for the will-quit maintenance barrier. Maintenance must
 * terminate before independent process teardown starts. Failed maintenance
 * cleanup is never promoted to success, but cannot skip child-process cleanup.
 */

export interface NarrativeMaintenanceQuitEvent {
  preventDefault(): void;
}

export interface NarrativeMaintenanceQuitFinalizerOptions {
  dispose(): void | Promise<void>;
  complete(): void | Promise<void>;
  quit(): void;
  exit(code: number): void;
  error?(error: unknown): void;
  maxAttempts?: number;
  /** Monotonic Native observation budget; independent cleanup is not bound by it. */
  nativeObservationBudgetMs?: number;
  /**
   * Asked once when shutdown could not be proven, right before the fatal
   * `exit(1)`. `stay` cancels the exit (the quit stays vetoed and a later quit
   * runs the whole finalizer again); `exit` or a throw keeps the fatal exit.
   * A `will-quit` that re-enters while the confirmation is open is only
   * vetoed. Whether anything is left to go back to (a window still alive with
   * unsaved edits) is the confirmation's own check after the answer, so a
   * `stay` is never overridden here (DR-PUBG-36-1).
   * Absent means the previous behaviour. It must not save or move any text
   * (DR-PUBG-36-1).
   */
  confirmFatalExit?(): "exit" | "stay" | Promise<"exit" | "stay">;
}

/** Attempt every independent teardown, including after another one rejects. */
export async function runIndependentShutdownCleanups(
  cleanups: ReadonlyArray<() => void | Promise<void>>,
): Promise<void> {
  const results = await Promise.allSettled(
    cleanups.map((cleanup) => Promise.resolve().then(cleanup)),
  );
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "independent process teardown failed");
  }
}

export function createNarrativeMaintenanceQuitFinalizer(
  options: NarrativeMaintenanceQuitFinalizerOptions,
): (event: NarrativeMaintenanceQuitEvent) => Promise<void> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      "maintenance shutdown maxAttempts must be a positive integer",
    );
  }
  const nativeObservationBudgetMs = options.nativeObservationBudgetMs ?? 30_000;
  if (
    !Number.isSafeInteger(nativeObservationBudgetMs) ||
    nativeObservationBudgetMs < 1
  ) {
    throw new Error(
      "native shutdown observation budget must be a positive integer",
    );
  }
  let finalizationStarted = false;
  let cleanupComplete = false;
  let fatalExitRequested = false;
  const reportError = (error: unknown): void => {
    try {
      options.error?.(error);
    } catch {
      // A diagnostic callback cannot interrupt process teardown.
    }
  };

  return async (event) => {
    if (cleanupComplete || fatalExitRequested) return;
    event.preventDefault();
    // A will-quit while the confirmation is open (the dialog has no parent
    // window, so a window can still close and ask to quit) is vetoed and
    // consumed here. The confirmation re-counts the live windows after the
    // answer and turns a `stay` with none left into `exit`.
    if (finalizationStarted) return;
    finalizationStarted = true;

    const nativeObservationStartedAt = performance.now();
    const observeNativeTermination = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const remaining =
          nativeObservationBudgetMs -
          (performance.now() - nativeObservationStartedAt);
        if (remaining <= 0) {
          reportError(new Error("NEX_NATIVE_SHUTDOWN_OBSERVATION_TIMEOUT"));
          return false;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Invoke dispose before the first await so re-entrant will-quit
          // callers observe the shared in-flight Native operation immediately.
          const disposeResult = Promise.resolve(options.dispose());
          await Promise.race([
            disposeResult,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error("NEX_NATIVE_SHUTDOWN_OBSERVATION_TIMEOUT")),
                remaining,
              );
            }),
          ]);
          if (timer !== undefined) clearTimeout(timer);
          return true;
        } catch (error) {
          if (timer !== undefined) clearTimeout(timer);
          reportError(error);
          if (
            error instanceof Error &&
            error.message === "NEX_NATIVE_SHUTDOWN_OBSERVATION_TIMEOUT"
          ) {
            return false;
          }
        }
      }
      return false;
    };

    // Independent process cleanup starts immediately. It must not wait behind
    // a Native worker that is still draining or has consumed the observation
    // budget. Both outcomes are required before graceful quit is allowed.
    const nativeResult = observeNativeTermination();
    const independentResult = Promise.resolve()
      .then(() => options.complete())
      .then(
        () => true,
        (error) => {
          reportError(error);
          return false;
        },
      );
    const [maintenanceComplete, independentCleanupComplete] = await Promise.all(
      [nativeResult, independentResult],
    );
    if (!maintenanceComplete || !independentCleanupComplete) {
      if (options.confirmFatalExit) {
        let decision: "exit" | "stay" = "exit";
        try {
          decision = await options.confirmFatalExit();
        } catch (error) {
          reportError(error);
        }
        if (decision === "stay") {
          // The quit was vetoed above. Allow the next quit to try again; the
          // author has been told to copy their unsaved text out first.
          finalizationStarted = false;
          return;
        }
      }
      fatalExitRequested = true;
      options.exit(1);
      return;
    }
    cleanupComplete = true;
    options.quit();
  };
}
