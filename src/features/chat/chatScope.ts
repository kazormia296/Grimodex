export type ChatScope = "scene" | "folder" | "project" | "codex" | "snippet";

export interface ScopeSessionKey {
  /** scene/folder: anchor node。project: null (= node_id IS NULL)。それ以外: undefined */
  nodeId: string | null | undefined;
  codexAnchorId: string | undefined;
  snippetAnchorId: string | undefined;
}

export function scopeSessionKeysEqual(
  left: ScopeSessionKey,
  right: ScopeSessionKey,
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.codexAnchorId === right.codexAnchorId &&
    left.snippetAnchorId === right.snippetAnchorId
  );
}

export function resolveScopeSessionKey(
  scope: ChatScope,
  activeSceneId: string | null | undefined,
  scopeAnchorId: string | null | undefined,
): ScopeSessionKey {
  // exhaustive switch: 新スコープ追加時に default フォールスルーで
  // project (nodeId: null) へ静かに化けるバグを型エラーで検出する。
  switch (scope) {
    case "scene":
      return {
        nodeId: activeSceneId || undefined,
        codexAnchorId: undefined,
        snippetAnchorId: undefined,
      };
    case "folder":
      return {
        nodeId: scopeAnchorId || undefined,
        codexAnchorId: undefined,
        snippetAnchorId: undefined,
      };
    case "codex":
      return {
        nodeId: undefined,
        codexAnchorId: scopeAnchorId || undefined,
        snippetAnchorId: undefined,
      };
    case "snippet":
      return {
        nodeId: undefined,
        codexAnchorId: undefined,
        snippetAnchorId: scopeAnchorId || undefined,
      };
    case "project":
      return {
        nodeId: null,
        codexAnchorId: undefined,
        snippetAnchorId: undefined,
      };
    default:
      scope satisfies never;
      return {
        nodeId: undefined,
        codexAnchorId: undefined,
        snippetAnchorId: undefined,
      };
  }
}
