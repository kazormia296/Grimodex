/**
 * Registry of per-scene save handlers.
 * EditorPane / LinearSceneBlock register their save function here so external
 * callers (tab context menu "Save all and close", agent writes, rename
 * propagation, post-effect flush, …) can trigger saves without accessing
 * editor component state directly.
 */
const handlers = new Map<string, () => Promise<void>>();

export function registerSaveHandler(nodeId: string, fn: () => Promise<void>) {
  handlers.set(nodeId, fn);
}

/**
 * Unregister a save handler. Pass the registered `fn` to make the call a
 * no-op when a newer instance for the same nodeId has already re-registered
 * (remount races: the new mount's register can run before the old mount's
 * cleanup — an unconditional delete would drop the live handler).
 */
export function unregisterSaveHandler(
  nodeId: string,
  fn?: () => Promise<void>,
) {
  if (fn !== undefined && handlers.get(nodeId) !== fn) return;
  handlers.delete(nodeId);
}

/** Save a scene by nodeId. No-op if no handler is registered. */
export async function saveScene(nodeId: string): Promise<void> {
  const fn = handlers.get(nodeId);
  if (fn) await fn();
}

/**
 * IDs of every node with a live, flushable editor (tab panes and mounted
 * linear blocks alike). Callers that need "flush all open editors so the DB
 * reflects unsaved edits" should iterate this — a tab list misses linear-mode
 * editors, which have no tab.
 */
export function registeredSaveHandlerIds(): string[] {
  return [...handlers.keys()];
}
