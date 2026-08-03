export interface CodexAnchorLifecyclePort {
  onDeleted: (entryId: string) => void;
}

let registeredCodexAnchorLifecycle: CodexAnchorLifecyclePort | null = null;

/** Install concrete Codex anchor consumers from the renderer composition root. */
export function registerCodexAnchorLifecycle(
  port: CodexAnchorLifecyclePort,
): void {
  registeredCodexAnchorLifecycle = port;
}

/** Notify consumers after a Codex entry has been deleted and reloaded. */
export function notifyCodexAnchorDeleted(entryId: string): void {
  if (!registeredCodexAnchorLifecycle) {
    throw new Error("Codex anchor lifecycle dependencies are not registered");
  }
  registeredCodexAnchorLifecycle.onDeleted(entryId);
}

/**
 * Low-level deletion paths also run during rollback and startup composition.
 * Their durable success must not be converted into a failure solely because
 * the optional renderer consumer has not been installed yet.
 */
export function notifyCodexAnchorDeletedIfRegistered(entryId: string): void {
  registeredCodexAnchorLifecycle?.onDeleted(entryId);
}
