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
