import type { MapEdge } from "@/db/schema";
import type { MapNodePositionRecord } from "../types";

function posToRfId(pos: MapNodePositionRecord): string | null {
  if (pos.nodeRefType === "scene" && pos.treeNodeId)
    return `scene:${pos.treeNodeId}`;
  if (pos.nodeRefType === "note" && pos.treeNodeId)
    return `note:${pos.treeNodeId}`;
  if (pos.nodeRefType === "codex" && pos.codexEntryId)
    return `codex:${pos.codexEntryId}`;
  if (pos.nodeRefType === "ai" && pos.aiNodeId) return `ai:${pos.aiNodeId}`;
  return null;
}

/**
 * Returns the set of node IDs (RF format, e.g. "scene:xxx") that are
 * adjacent to focusedNodeId. Traverses both visible edges AND raw user
 * edges regardless of show.userEdges so focus mode always reflects
 * actual connections.
 */
export function buildFocusNeighbors(
  focusedNodeId: string | null,
  visibleEdges: { source: string; target: string }[],
  userEdges: MapEdge[],
  positions: MapNodePositionRecord[],
): Set<string> {
  if (!focusedNodeId) return new Set();

  const connected = new Set<string>([focusedNodeId]);

  for (const edge of visibleEdges) {
    if (edge.source === focusedNodeId) connected.add(edge.target);
    if (edge.target === focusedNodeId) connected.add(edge.source);
  }

  const posById = new Map(positions.map((p) => [p.id, p]));
  for (const ue of userEdges) {
    const fromRf = posToRfId(
      posById.get(ue.fromPositionId) ?? ({} as MapNodePositionRecord),
    );
    const toRf = posToRfId(
      posById.get(ue.toPositionId) ?? ({} as MapNodePositionRecord),
    );
    if (fromRf === focusedNodeId && toRf) connected.add(toRf);
    if (toRf === focusedNodeId && fromRf) connected.add(fromRf);
  }

  return connected;
}
