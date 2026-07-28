import type { MapNodePositionRecord } from "../types";

export interface MapPositionProjection {
  readonly source: readonly MapNodePositionRecord[];
  readonly positionedTreeNodeIds: ReadonlySet<string>;
  readonly positionedCodexIds: ReadonlySet<string>;
  readonly positionedSnippetIds: ReadonlySet<string>;
  readonly positionById: ReadonlyMap<string, MapNodePositionRecord>;
  readonly pinnedLayoutNodeIds: readonly string[];
  readonly zIndexByNodeKey: ReadonlyMap<string, number>;
  readonly snippetPositions: ReadonlyMap<string, { x: number; y: number }>;
  readonly notePositions: ReadonlyMap<string, { x: number; y: number }>;
  readonly stickyPositions: ReadonlyMap<string, { x: number; y: number }>;
  readonly aiBranchPositions: ReadonlyMap<string, { x: number; y: number }>;
}

/**
 * One structural pass shared by node filtering, layout invalidation and node
 * presentation. The caller controls when it is rebuilt via explicit position
 * revisions, so x/y-only state updates never execute this scan.
 */
export function projectMapPositions(
  positions: readonly MapNodePositionRecord[],
): MapPositionProjection {
  const positionedTreeNodeIds = new Set<string>();
  const positionedCodexIds = new Set<string>();
  const positionedSnippetIds = new Set<string>();
  const positionById = new Map<string, MapNodePositionRecord>();
  const pinnedLayoutNodeIds: string[] = [];
  const zIndexByNodeKey = new Map<string, number>();
  const snippetPositions = new Map<string, { x: number; y: number }>();
  const notePositions = new Map<string, { x: number; y: number }>();
  const stickyPositions = new Map<string, { x: number; y: number }>();
  const aiBranchPositions = new Map<string, { x: number; y: number }>();

  for (const position of positions) {
    positionById.set(position.id, position);
    if (position.treeNodeId) {
      positionedTreeNodeIds.add(position.treeNodeId);
    }
    if (position.codexEntryId) {
      positionedCodexIds.add(position.codexEntryId);
    }
    if (position.snippetId) {
      positionedSnippetIds.add(position.snippetId);
    }

    if (
      position.pinned === 1 &&
      (position.nodeRefType === "scene" || position.nodeRefType === "codex")
    ) {
      const pinnedId = position.treeNodeId ?? position.codexEntryId;
      if (pinnedId) pinnedLayoutNodeIds.push(pinnedId);
    }

    if (position.treeNodeId && position.nodeRefType === "scene") {
      zIndexByNodeKey.set(`scene:${position.treeNodeId}`, position.zIndex ?? 0);
    } else if (position.treeNodeId && position.nodeRefType === "note") {
      zIndexByNodeKey.set(`note:${position.treeNodeId}`, position.zIndex ?? 0);
    } else if (position.codexEntryId) {
      zIndexByNodeKey.set(
        `codex:${position.codexEntryId}`,
        position.zIndex ?? 0,
      );
    } else if (position.snippetId) {
      zIndexByNodeKey.set(
        `snippet:${position.snippetId}`,
        position.zIndex ?? 0,
      );
    } else if (position.stickyId) {
      zIndexByNodeKey.set(`sticky:${position.stickyId}`, position.zIndex ?? 0);
    } else if (position.aiBranchId) {
      zIndexByNodeKey.set(
        `ai_branch:${position.aiBranchId}`,
        position.zIndex ?? 0,
      );
    }

    if (position.snippetId) {
      snippetPositions.set(`snippet:${position.snippetId}`, {
        x: position.x,
        y: position.y,
      });
    }
    if (position.treeNodeId && position.nodeRefType === "note") {
      notePositions.set(`note:${position.treeNodeId}`, {
        x: position.x,
        y: position.y,
      });
    }
    if (position.stickyId) {
      stickyPositions.set(`sticky:${position.stickyId}`, {
        x: position.x,
        y: position.y,
      });
    }
    if (position.aiBranchId) {
      aiBranchPositions.set(`ai_branch:${position.aiBranchId}`, {
        x: position.x,
        y: position.y,
      });
    }
  }

  return {
    source: positions,
    positionedTreeNodeIds,
    positionedCodexIds,
    positionedSnippetIds,
    positionById,
    pinnedLayoutNodeIds: pinnedLayoutNodeIds.sort(),
    zIndexByNodeKey,
    snippetPositions,
    notePositions,
    stickyPositions,
    aiBranchPositions,
  };
}
