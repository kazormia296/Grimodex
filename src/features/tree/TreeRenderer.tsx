import { Fragment } from "react";
import type { RefObject } from "react";
import { TreeNodeItem } from "./TreeNodeItem";
import type { TreeNodeData } from "./treeStore";
import { InlineSynopsisEditor } from "@/features/editor/InlineSynopsisEditor";
import { isNodeVisible } from "./treeVisibility";
import type { PlotThreadRow } from "@/features/plot-threads/api";

const EMPTY_CELLS: Record<string, string> = {};

export interface TreeRendererProps {
  parentId: string | null;
  childMap: Record<string, string[]>;
  nodeMap: Record<string, TreeNodeData>;
  depth: number;
  activeSceneId: string;
  selectedIds: string[];
  expandedIds: string[];
  filterQuery: string;
  statusFilter?: string | null;
  labelFilter?: string[];
  nodeLabels?: Record<string, string[]>;
  threadFilter?: string[];
  /** nodeId → plot-thread ids (membership). Drives the thread filter. */
  nodeThreadIds?: Record<string, string[]>;
  /** Plot-thread track columns (subway gutter). Stable reference. */
  trackColumns?: PlotThreadRow[];
  /** nodeId → per-column track state string (buildSceneThreadTracks). */
  cellByNode?: Record<string, string>;
  /** nodeId → branch/merge connector string (buildSceneThreadTracks). */
  connectorByNode?: Record<string, string>;
  viewMode: string;
  showWordCounts: boolean;
  showStatusDots: boolean;
  showLabelDots: boolean;
  showPlotThreadTrack: boolean;
  showAiAttribution: boolean;
  /** For folder ids, the flat list of leaf descendant ids — used by
   *  TreeNodeItem to compute its own running total via per-id selector. */
  leafDescendantsByFolder: Record<string, string[]>;
  /** Shift+Click 範囲選択用の可視ノード列。ref 渡し (TreeNodeItem 参照)。 */
  orderedNodesRef: RefObject<TreeNodeData[]>;
  /** ドラッグ中フラグ (クリック/リネーム抑止用)。 */
  dragInProgress: boolean;
}

export function TreeRenderer({
  parentId,
  childMap,
  nodeMap,
  depth,
  activeSceneId,
  selectedIds,
  expandedIds,
  filterQuery,
  statusFilter,
  labelFilter,
  nodeLabels,
  threadFilter,
  nodeThreadIds,
  trackColumns,
  cellByNode,
  connectorByNode,
  viewMode,
  showWordCounts,
  showStatusDots,
  showLabelDots,
  showPlotThreadTrack,
  showAiAttribution,
  leafDescendantsByFolder,
  orderedNodesRef,
  dragInProgress,
}: TreeRendererProps) {
  const ids = childMap[parentId ?? "root"] ?? [];
  const query = filterQuery.toLowerCase();

  return (
    <>
      {ids.map((id) => {
        const node = nodeMap[id];
        if (!node) return null;
        const visible = isNodeVisible(
          node,
          childMap,
          nodeMap,
          query,
          statusFilter,
          labelFilter,
          nodeLabels,
          threadFilter,
          nodeThreadIds,
        );
        // フィルタ非表示ノードはここで mount 自体をスキップする。
        // TreeNodeItem 内の return null だと useDraggable/useDroppable 等の
        // 全 hook をノード数ぶん回してしまう (visible=false なら子孫も
        // 全て不可視なので subtree ごと落として良い)。
        if (!visible) return null;
        const isFolder = node.nodeType === "folder";
        // isExpanded は folder の開閉と検索時の自動展開にのみ意味がある。
        // 葉にも `!!query && visible` を渡すと検索 1 文字目で全行の props が
        // flip して memo が無効化されるため folder に限定する。
        const isExpanded =
          isFolder &&
          (expandedIds.includes(id) ||
            !!query ||
            (threadFilter?.length ?? 0) > 0);
        const itemProps = {
          node,
          depth,
          isActive: node.id === activeSceneId,
          isSelected: selectedIds.includes(id),
          isExpanded,
          leafDescendants: leafDescendantsByFolder[id],
          showWordCounts,
          showStatusDots,
          showLabelDots,
          showPlotThreadTrack,
          showAiAttribution,
          trackColumns,
          trackCells: (cellByNode ?? EMPTY_CELLS)[id] ?? "",
          trackConnectors: (connectorByNode ?? EMPTY_CELLS)[id] ?? "",
          orderedNodesRef,
          dragInProgress,
          viewMode,
        };
        return (
          <Fragment key={id}>
            {/* children (再帰 JSX) は毎 render 新規参照になり memo を破る
                ため、実際に使う folder にだけ渡す。葉は children 無しで
                memo がフルに効く。 */}
            {isFolder ? (
              <TreeNodeItem {...itemProps}>
                <TreeRenderer
                  parentId={id}
                  childMap={childMap}
                  nodeMap={nodeMap}
                  depth={depth + 1}
                  activeSceneId={activeSceneId}
                  selectedIds={selectedIds}
                  expandedIds={expandedIds}
                  filterQuery={filterQuery}
                  statusFilter={statusFilter}
                  labelFilter={labelFilter}
                  nodeLabels={nodeLabels}
                  threadFilter={threadFilter}
                  nodeThreadIds={nodeThreadIds}
                  trackColumns={trackColumns}
                  cellByNode={cellByNode}
                  connectorByNode={connectorByNode}
                  viewMode={viewMode}
                  showWordCounts={showWordCounts}
                  showStatusDots={showStatusDots}
                  showLabelDots={showLabelDots}
                  showPlotThreadTrack={showPlotThreadTrack}
                  showAiAttribution={showAiAttribution}
                  leafDescendantsByFolder={leafDescendantsByFolder}
                  orderedNodesRef={orderedNodesRef}
                  dragInProgress={dragInProgress}
                />
              </TreeNodeItem>
            ) : (
              <TreeNodeItem {...itemProps} />
            )}
            {viewMode === "outline" && node.nodeType === "scene" && (
              <li
                className="list-none"
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
              </li>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
