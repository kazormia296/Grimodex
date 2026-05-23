import type { MapNodePositionRecord } from "../types";

/** Map a position row to its React Flow / force-layout node key. */
export function posToNodeKey(
  pos: MapNodePositionRecord | undefined,
): string | null {
  if (!pos) return null;
  if (pos.nodeRefType === "scene" && pos.treeNodeId)
    return `scene:${pos.treeNodeId}`;
  if (pos.nodeRefType === "note" && pos.treeNodeId)
    return `note:${pos.treeNodeId}`;
  if (pos.nodeRefType === "codex" && pos.codexEntryId)
    return `codex:${pos.codexEntryId}`;
  if (pos.nodeRefType === "ai_branch" && pos.aiBranchId)
    return `ai_branch:${pos.aiBranchId}`;
  if (pos.nodeRefType === "sticky" && pos.stickyId)
    return `sticky:${pos.stickyId}`;
  if (pos.nodeRefType === "snippet" && pos.snippetId)
    return `snippet:${pos.snippetId}`;
  return null;
}
