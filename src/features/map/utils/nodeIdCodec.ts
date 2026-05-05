import type { MapNodePositionRecord, NodeRefType } from "../types";

/** Find the position record for a React Flow node ID in the positions array. */
export function findPosByNodeId(
  positions: MapNodePositionRecord[],
  nodeId: string,
): MapNodePositionRecord | undefined {
  if (nodeId.startsWith("scene:"))
    return positions.find(
      (p) =>
        p.nodeRefType === "scene" &&
        p.treeNodeId === nodeId.slice("scene:".length),
    );
  if (nodeId.startsWith("codex:"))
    return positions.find(
      (p) => p.codexEntryId === nodeId.slice("codex:".length),
    );
  if (nodeId.startsWith("snippet:"))
    return positions.find(
      (p) => p.snippetId === nodeId.slice("snippet:".length),
    );
  if (nodeId.startsWith("note:"))
    return positions.find(
      (p) =>
        p.nodeRefType === "note" &&
        p.treeNodeId === nodeId.slice("note:".length),
    );
  if (nodeId.startsWith("sticky:"))
    return positions.find((p) => p.stickyId === nodeId.slice("sticky:".length));
  if (nodeId.startsWith("ai_branch:"))
    return positions.find(
      (p) => p.aiBranchId === nodeId.slice("ai_branch:".length),
    );
  return undefined;
}

type UpsertArgs = {
  boardId: string;
  nodeRefType: NodeRefType;
  treeNodeId?: string;
  codexEntryId?: string;
  snippetId?: string;
  stickyId?: string;
  aiBranchId?: string;
  x: number;
  y: number;
};

/** Build upsertNodePosition args for any supported node type (null for frames). */
export function buildUpsertArgs(
  boardId: string,
  nodeId: string,
  x = 0,
  y = 0,
): UpsertArgs | null {
  if (nodeId.startsWith("scene:"))
    return {
      boardId,
      nodeRefType: "scene",
      treeNodeId: nodeId.slice("scene:".length),
      x,
      y,
    };
  if (nodeId.startsWith("codex:"))
    return {
      boardId,
      nodeRefType: "codex",
      codexEntryId: nodeId.slice("codex:".length),
      x,
      y,
    };
  if (nodeId.startsWith("snippet:"))
    return {
      boardId,
      nodeRefType: "snippet",
      snippetId: nodeId.slice("snippet:".length),
      x,
      y,
    };
  if (nodeId.startsWith("note:"))
    return {
      boardId,
      nodeRefType: "note",
      treeNodeId: nodeId.slice("note:".length),
      x,
      y,
    };
  if (nodeId.startsWith("sticky:"))
    return {
      boardId,
      nodeRefType: "sticky",
      stickyId: nodeId.slice("sticky:".length),
      x,
      y,
    };
  if (nodeId.startsWith("ai_branch:"))
    return {
      boardId,
      nodeRefType: "ai_branch",
      aiBranchId: nodeId.slice("ai_branch:".length),
      x,
      y,
    };
  return null;
}
