/**
 * Leaf-level IPC outcome guard.
 *
 * Keep this independent from `tauri.ts`: importing the full transport module
 * from a low-level store pulls BrowserMock and feature modules into the store's
 * initialization graph. The wire-level `outcome` discriminator is stable
 * across Tauri, Electron, and browser transports, and also survives
 * serialization where `instanceof IpcInvokeError` would not.
 */
export function isUnknownIpcOutcomeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "outcome" in error &&
    error.outcome === "unknown"
  );
}

/**
 * Structural IPC error-code guard that survives wrappers and renderer
 * serialization without pulling the transport implementation into leaf
 * modules. Stable IPC decisions must use this discriminator instead of
 * matching human-readable error text.
 */
export function hasIpcErrorCode(error: unknown, code: string): boolean {
  const visited = new Set<object>();
  const pending: unknown[] = [error];

  while (pending.length > 0) {
    const candidate = pending.pop();
    if (typeof candidate !== "object" || candidate === null) continue;
    if (visited.has(candidate)) continue;
    visited.add(candidate);

    if ("code" in candidate && candidate.code === code) return true;
    if ("cause" in candidate) pending.push(candidate.cause);
    if ("details" in candidate) pending.push(candidate.details);
    if ("errors" in candidate && Array.isArray(candidate.errors)) {
      pending.push(...candidate.errors);
    }
  }

  return false;
}
