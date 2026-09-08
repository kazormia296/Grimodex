const RECONCILIATION_INTERVAL_MS = 250;

interface ReconcilerOptions {
  readonly reconcile: () => Promise<{ readonly activeOperations: number }>;
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

  function schedule(delay: number) {
    if (disposed || running || tickets.size === 0) return;
    stopTimer();
    timer = setTimeout(() => { timer = null; void run(); }, delay);
    // Keep this observer from extending process lifetime during app shutdown.
    timer.unref?.();
  }

  async function run() {
    if (disposed || running || tickets.size === 0) return;
    running = true;
    const capturedMutation = mutation;
    try {
      const result = await options.reconcile();
      if (!Number.isSafeInteger(result.activeOperations) || result.activeOperations < 0) {
        throw new Error("RELATED_SCENES_INVALID_RECONCILIATION");
      }
      if (result.activeOperations === 0 && mutation === capturedMutation) tickets.clear();
    } catch (error) {
      options.reportFailure?.(error);
    } finally {
      running = false;
      const delay = wakeQueued ? 0 : RECONCILIATION_INTERVAL_MS;
      wakeQueued = false;
      schedule(delay);
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
      if (timer === null) schedule(RECONCILIATION_INTERVAL_MS);
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
      schedule(0);
    },
    dispose() {
      disposed = true;
      mutation += 1;
      tickets.clear();
      stopTimer();
    },
  };
}
