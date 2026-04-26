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
  if (nodeId.startsWith("note:"))
    return positions.find(
      (p) =>
        p.nodeRefType === "note" &&
        p.treeNodeId === nodeId.slice("note:".length),
    );
  if (nodeId.startsWith("ai:"))
    return positions.find((p) => p.aiNodeId === nodeId.slice("ai:".length));
  return undefined;
}

type UpsertArgs = {
  boardId: string;
  nodeRefType: NodeRefType;
  treeNodeId?: string;
  codexEntryId?: string;
  aiNodeId?: string;
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
  if (nodeId.startsWith("note:"))
    return {
      boardId,
      nodeRefType: "note",
      treeNodeId: nodeId.slice("note:".length),
      x,
      y,
    };
  if (nodeId.startsWith("ai:"))
    return {
      boardId,
      nodeRefType: "ai",
      aiNodeId: nodeId.slice("ai:".length),
      x,
      y,
    };
  return null;
}
