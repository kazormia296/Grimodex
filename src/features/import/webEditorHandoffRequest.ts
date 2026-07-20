type WebEditorHandoffRequestListener = () => void;

const listeners = new Set<WebEditorHandoffRequestListener>();
let pendingRequest = false;

/**
 * Queues a UI-only request to open the desktop handoff importer. The request
 * intentionally contains no path or manuscript data; the native file picker
 * remains the sole authority for selecting the downloaded handoff.
 */
export function requestWebEditorHandoffImport(): void {
  pendingRequest = true;
  for (const listener of listeners) listener();
}

export function subscribeWebEditorHandoffRequests(
  listener: WebEditorHandoffRequestListener,
): () => void {
  listeners.add(listener);
  if (pendingRequest) listener();
  return () => listeners.delete(listener);
}

export function consumeWebEditorHandoffRequest(): boolean {
  if (!pendingRequest) return false;
  pendingRequest = false;
  return true;
}
