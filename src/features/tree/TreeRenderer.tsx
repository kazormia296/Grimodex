import { Fragment } from "react";
import { TreeNodeItem } from "./TreeNodeItem";
import type { DropIndicator } from "./TreeNodeItem";
import type { TreeNodeData } from "./treeStore";
import { InlineSynopsisEditor } from "@/features/editor/InlineSynopsisEditor";
import { isNodeVisible } from "./treeVisibility";

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
  viewMode: string;
  showWordCounts: boolean;
  showStatusDots: boolean;
  showLabelDots: boolean;
  showAiAttribution: boolean;
  dropIndicator: DropIndicator | null;
  /** For folder ids, the flat list of leaf descendant ids — used by
   *  TreeNodeItem to compute its own running total via per-id selector. */
  leafDescendantsByFolder: Record<string, string[]>;
  orderedNodes: TreeNodeData[];
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
  viewMode,
  showWordCounts,
  showStatusDots,
  showLabelDots,
  showAiAttribution,
  dropIndicator,
  leafDescendantsByFolder,
  orderedNodes,
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
        );
        const isExpanded = expandedIds.includes(id) || (!!query && visible);
        return (
          <Fragment key={id}>
            <TreeNodeItem
              node={node}
              depth={depth}
              isActive={node.id === activeSceneId}
              isSelected={selectedIds.includes(id)}
              isExpanded={isExpanded}
              isVisible={visible}
              leafDescendants={leafDescendantsByFolder[id]}
              showWordCounts={showWordCounts}
              showStatusDots={showStatusDots}
              showLabelDots={showLabelDots}
              showAiAttribution={showAiAttribution}
              dropIndicator={dropIndicator}
              orderedNodes={orderedNodes}
              viewMode={viewMode}
            >
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
                viewMode={viewMode}
                showWordCounts={showWordCounts}
                showStatusDots={showStatusDots}
                showLabelDots={showLabelDots}
                showAiAttribution={showAiAttribution}
                dropIndicator={dropIndicator}
                leafDescendantsByFolder={leafDescendantsByFolder}
                orderedNodes={orderedNodes}
              />
            </TreeNodeItem>
            {viewMode === "outline" && node.nodeType === "scene" && visible && (
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
