/**
 * Feature-neutral projection used by workspace switching. Keeping only the
 * boolean avoids a workspace -> editor store dependency (and its import cycle)
 * while still making unresolved editor buffers part of the quiesce contract.
 */
let unresolvedEditorChanges = false;
const pendingEditorWrites = new Set<Promise<unknown>>();

export function setUnresolvedEditorChanges(value: boolean): void {
  unresolvedEditorChanges = value;
}

export function hasUnresolvedEditorChanges(): boolean {
  return unresolvedEditorChanges;
}

/** Track a non-debounced editor write so workspace quiesce can await it. */
export function trackPendingEditorWrite<T>(write: Promise<T>): Promise<T> {
  pendingEditorWrites.add(write);
  void write.finally(() => pendingEditorWrites.delete(write)).catch(() => {});
  return write;
}

/** Wait until writes present now, and writes spawned by them, have settled. */
export async function awaitPendingEditorWrites(): Promise<void> {
  const failures: unknown[] = [];
  while (pendingEditorWrites.size > 0) {
    const results = await Promise.allSettled([...pendingEditorWrites]);
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more editor writes failed");
  }
}
