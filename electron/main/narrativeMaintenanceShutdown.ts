/**
 * Main-process owner for the will-quit maintenance barrier.  The handler
 * prevents the current quit synchronously, waits for the Native terminal
 * receipt, and either retries the same barrier on a later will-quit event or
 * advances to an explicit fatal exit after the bounded retry count.
 */

export interface NarrativeMaintenanceQuitEvent {
  preventDefault(): void;
}

export interface NarrativeMaintenanceQuitFinalizerOptions {
  dispose(): void | Promise<void>;
  complete(): void;
  quit(): void;
  exit(code: number): void;
  error?(error: unknown): void;
  maxAttempts?: number;
}

export function createNarrativeMaintenanceQuitFinalizer(
  options: NarrativeMaintenanceQuitFinalizerOptions,
): (event: NarrativeMaintenanceQuitEvent) => Promise<void> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  let finalizationStarted = false;
  let cleanupComplete = false;
  let failureCount = 0;
  let fatalExitRequested = false;

  return async (event) => {
    if (cleanupComplete || fatalExitRequested) return;
    event.preventDefault();
    if (finalizationStarted) return;
    finalizationStarted = true;
    while (!cleanupComplete && !fatalExitRequested) {
      try {
        await options.dispose();
        options.complete();
        cleanupComplete = true;
        options.quit();
      } catch (error) {
        failureCount += 1;
        options.error?.(error);
        if (failureCount >= maxAttempts) {
          fatalExitRequested = true;
          options.exit(1);
          return;
        }
        // Retry the same owned barrier within this invocation. Reentrant
        // will-quit events still observe finalizationStarted and cannot start
        // a second disposal concurrently.
      }
    }
  };
}
