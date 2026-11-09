const RECONCILIATION_INTERVAL_MS = 250;

interface ReconcilerOptions {
  /** `periodic` is true only for a timer-driven round, which must not wait for
   * a busy database connection (DR-MPS-15). A round that follows a commit
   * (`wake`) passes false and waits as before. */
  readonly reconcile: (periodic: boolean) => Promise<{ readonly activeOperations: number }>;
  readonly reportFailure?: (error: unknown) => void;
}

/** Only live query tickets require external-commit discovery. Canonical
 * validation remains Native-owned and is repeated at return and click. */
export function createRelatedScenesReconciler(options: ReconcilerOptions) {
  const tickets = new Map<string, Set<string>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let disposed = false;
  let mutation = 0;
  let wakeQueued = false;

  function stopTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  // `periodic` is captured per timer, never shared: only a timer armed by
  // `track` or by the end of a run is periodic; `wake` (and the run queued
  // behind a running one) is not.
  function schedule(delay: number, periodic: boolean) {
    if (disposed || running || tickets.size === 0) return;
    stopTimer();
    timer = setTimeout(() => { timer = null; void run(periodic); }, delay);
    // Keep this observer from extending process lifetime during app shutdown.
    timer.unref?.();
  }

  async function run(periodic: boolean) {
    if (disposed || running || tickets.size === 0) return;
    running = true;
    const capturedMutation = mutation;
    try {
      const result = await options.reconcile(periodic);
      if (!Number.isSafeInteger(result.activeOperations) || result.activeOperations < 0) {
        throw new Error("RELATED_SCENES_INVALID_RECONCILIATION");
      }
      if (result.activeOperations === 0 && mutation === capturedMutation) tickets.clear();
    } catch (error) {
      options.reportFailure?.(error);
    } finally {
      running = false;
      const woken = wakeQueued;
      wakeQueued = false;
      schedule(woken ? 0 : RECONCILIATION_INTERVAL_MS, !woken);
    }
  }

  return {
    track(ownerKey: string, ticket: string) {
      if (disposed) return;
      const owned = tickets.get(ownerKey) ?? new Set<string>();
      if (owned.has(ticket)) return;
      owned.add(ticket);
      tickets.set(ownerKey, owned);
      mutation += 1;
      if (timer === null) schedule(RECONCILIATION_INTERVAL_MS, true);
    },
    release(ownerKey: string, ticket: string) {
      const owned = tickets.get(ownerKey);
      if (!owned?.delete(ticket)) return;
      mutation += 1;
      if (owned.size === 0) tickets.delete(ownerKey);
      if (tickets.size === 0) stopTimer();
    },
    releaseOwner(ownerKey: string) {
      if (tickets.delete(ownerKey)) mutation += 1;
      if (tickets.size === 0) stopTimer();
    },
    wake() {
      if (disposed || tickets.size === 0) return;
      if (running) { wakeQueued = true; return; }
      schedule(0, false);
    },
    dispose() {
      disposed = true;
      mutation += 1;
      tickets.clear();
      stopTimer();
    },
  };
}
