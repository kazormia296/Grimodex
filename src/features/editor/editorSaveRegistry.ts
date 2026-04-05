/**
 * Registry of per-scene save handlers.
 * EditorPane registers its save function here so external callers
 * (e.g. the tab context menu "Save all and close") can trigger saves
 * without accessing EditorPane state directly.
 */
const handlers = new Map<string, () => Promise<void>>();

export function registerSaveHandler(nodeId: string, fn: () => Promise<void>) {
  handlers.set(nodeId, fn);
}

export function unregisterSaveHandler(nodeId: string) {
  handlers.delete(nodeId);
}

/** Save a scene by nodeId. No-op if no handler is registered. */
export async function saveScene(nodeId: string): Promise<void> {
  const fn = handlers.get(nodeId);
  if (fn) await fn();
}
