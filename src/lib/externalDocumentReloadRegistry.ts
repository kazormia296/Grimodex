type ExternalDocumentReloadListener = (stateKey: string, nonce: number) => void;

const reloadNonceByStateKey = new Map<string, number>();
const listeners = new Set<ExternalDocumentReloadListener>();

/**
 * Publish an exact-document canonical reload without coupling the writer's
 * feature to the concurrency Zustand store.
 */
export function publishExternalDocumentReload(stateKey: string): number {
  const nonce = (reloadNonceByStateKey.get(stateKey) ?? 0) + 1;
  reloadNonceByStateKey.set(stateKey, nonce);
  for (const listener of listeners) listener(stateKey, nonce);
  return nonce;
}

/**
 * Bridge canonical reload publications into a UI store. Replaying the current
 * values preserves publications that happen before the store module loads.
 */
export function subscribeExternalDocumentReloads(
  listener: ExternalDocumentReloadListener,
): () => void {
  listeners.add(listener);
  for (const [stateKey, nonce] of reloadNonceByStateKey) {
    listener(stateKey, nonce);
  }
  return () => listeners.delete(listener);
}

export function clearExternalDocumentReloadRegistry(): void {
  reloadNonceByStateKey.clear();
}
