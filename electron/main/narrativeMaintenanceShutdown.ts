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
    throw new Error("maintenance shutdown maxAttempts must be a positive integer");
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
    if (finalizationStarted) return;
    finalizationStarted = true;

    let maintenanceComplete = false;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await options.dispose();
        maintenanceComplete = true;
        break;
      } catch (error) {
        reportError(error);
      }
    }

    // This is attempted exactly once, even when all maintenance retries fail.
    // Its caller owns independent child-process teardown and waits for each
    // manager's existing completion contract before requesting process exit.
    let independentCleanupComplete = false;
    try {
      await options.complete();
      independentCleanupComplete = true;
    } catch (error) {
      reportError(error);
    }
    if (!maintenanceComplete || !independentCleanupComplete) {
      fatalExitRequested = true;
      options.exit(1);
      return;
    }
    cleanupComplete = true;
    options.quit();
  };
}
