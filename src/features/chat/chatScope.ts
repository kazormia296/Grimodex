export type ChatScope = "scene" | "folder" | "project" | "codex";

export function resolveScopeSessionKey(
  scope: ChatScope,
  activeSceneId: string | null | undefined,
  scopeAnchorId: string | null | undefined,
): { nodeId: string | null | undefined; codexAnchorId: string | undefined } {
  if (scope === "scene")
    return { nodeId: activeSceneId || undefined, codexAnchorId: undefined };
  if (scope === "folder")
    return { nodeId: scopeAnchorId || undefined, codexAnchorId: undefined };
  if (scope === "codex")
    return { nodeId: undefined, codexAnchorId: scopeAnchorId || undefined };
  return { nodeId: null, codexAnchorId: undefined };
}
