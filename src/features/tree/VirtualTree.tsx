import { useCallback, useEffect, useMemo } from "react";
import type { RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TreeNodeItem } from "./TreeNodeItem";
import { InlineSynopsisEditor } from "@/features/editor/InlineSynopsisEditor";
import type { VisibleTreeRow } from "./treeVisibility";
import type { PlotThreadRow } from "@/features/plot-threads/api";
import type { TreeNodeData } from "./treeStore";

const EMPTY_CELLS: Record<string, string> = {};

interface VirtualTreeProps {
  rows: VisibleTreeRow[];
  treeRef: RefObject<HTMLDivElement | null>;
  activeSceneId: string;
  selectedIds: string[];
  expandedIds: string[];
  viewMode: string;
  showWordCounts: boolean;
  showStatusDots: boolean;
  showLabelDots: boolean;
  showPlotThreadTrack: boolean;
  showAiAttribution: boolean;
  trackColumns?: PlotThreadRow[];
  cellByNode?: Record<string, string>;
  connectorByNode?: Record<string, string>;
  orderedNodesRef: RefObject<TreeNodeData[]>;
  draggingId: string | null;
  autoRevealActiveScene: boolean;
  pendingRevealId: string | null;
  onPendingRevealHandled: () => void;
  autoExpandFolders: boolean;
}

interface VirtualRange {
  startIndex: number;
  endIndex: number;
  overscan: number;
  count: number;
}

export function extractTreeVirtualIndexes(
  range: VirtualRange,
  pinnedIndex: number | null,
): number[] {
  const start = Math.max(0, range.startIndex - range.overscan);
  const end = Math.min(range.count - 1, range.endIndex + range.overscan);
  const indexes = Array.from(
    { length: Math.max(0, end - start + 1) },
    (_, offset) => start + offset,
  );
  if (
    pinnedIndex !== null &&
    pinnedIndex >= 0 &&
    pinnedIndex < range.count &&
    !indexes.includes(pinnedIndex)
  ) {
    indexes.push(pinnedIndex);
    indexes.sort((a, b) => a - b);
  }
  return indexes;
}

/**
 * Windowed flat Scenes tree. Visibility and depth are already resolved by the
 * shared post-order derivation, so rendering never rescans a subtree.
 */
export function VirtualTree({
  rows,
  treeRef,
  activeSceneId,
  selectedIds,
  expandedIds,
  viewMode,
  showWordCounts,
  showStatusDots,
  showLabelDots,
  showPlotThreadTrack,
  showAiAttribution,
  trackColumns,
  cellByNode,
  connectorByNode,
  orderedNodesRef,
  draggingId,
  autoRevealActiveScene,
  pendingRevealId,
  onPendingRevealHandled,
  autoExpandFolders,
}: VirtualTreeProps) {
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const expanded = useMemo(() => new Set(expandedIds), [expandedIds]);
  const indexById = useMemo(
    () => new Map(rows.map((row, index) => [row.node.id, index])),
    [rows],
  );
  const draggingIndex =
    draggingId === null ? null : (indexById.get(draggingId) ?? null);
  const rangeExtractor = useCallback(
    (range: VirtualRange) => extractTreeVirtualIndexes(range, draggingIndex),
    [draggingIndex],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => treeRef.current,
    estimateSize: (index) =>
      viewMode === "outline" && rows[index]?.node.nodeType === "scene"
        ? 64
        : 28,
    overscan: 10,
    getItemKey: (index) => rows[index]?.node.id ?? index,
    rangeExtractor,
  });

  useEffect(() => {
    if (!autoRevealActiveScene) return;
    const index = indexById.get(activeSceneId);
    if (index === undefined) return;
    virtualizer.scrollToIndex(index, { align: "auto", behavior: "smooth" });
  }, [activeSceneId, autoRevealActiveScene, indexById, virtualizer]);

  useEffect(() => {
    if (!pendingRevealId) return;
    const index = indexById.get(pendingRevealId);
    onPendingRevealHandled();
    if (index === undefined) return;
    virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
  }, [indexById, onPendingRevealHandled, pendingRevealId, virtualizer]);

  const measureElement = useCallback(
    (element: HTMLLIElement | null) => {
      if (element) virtualizer.measureElement(element);
    },
    [virtualizer],
  );

  return (
    <ul
      className="relative list-none"
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index];
        if (!row) return null;
        const { node, depth } = row;
        const isFolder = node.nodeType === "folder";
        const isExpanded =
          isFolder &&
          (autoExpandFolders ||
            expanded.has(node.id) ||
            (rows[virtualRow.index + 1]?.depth ?? depth) > depth);
        return (
          <TreeNodeItem
            key={virtualRow.key}
            node={node}
            depth={depth}
            isActive={node.id === activeSceneId}
            isSelected={selected.has(node.id)}
            isExpanded={isExpanded}
            showWordCounts={showWordCounts}
            showStatusDots={showStatusDots}
            showLabelDots={showLabelDots}
            showPlotThreadTrack={showPlotThreadTrack}
            showAiAttribution={showAiAttribution}
            trackColumns={trackColumns}
            trackCells={(cellByNode ?? EMPTY_CELLS)[node.id] ?? ""}
            trackConnectors={(connectorByNode ?? EMPTY_CELLS)[node.id] ?? ""}
            orderedNodesRef={orderedNodesRef}
            dragInProgress={draggingId !== null}
            viewMode={viewMode}
            virtualIndex={virtualRow.index}
            virtualStart={virtualRow.start}
            measureElement={measureElement}
            outlineSynopsis={
              viewMode === "outline" && node.nodeType === "scene" ? (
                <div
                  style={{
                    paddingLeft: `${depth * 12 + 58}px`,
                    paddingBottom: 4,
                  }}
                >
                  <InlineSynopsisEditor
                    nodeId={node.id}
                    synopsis={node.synopsis}
                    className="cursor-text rounded text-[11px] text-muted-foreground hover:bg-accent/30"
                  />
                </div>
              ) : undefined
            }
          />
        );
      })}
    </ul>
  );
}
