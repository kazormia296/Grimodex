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
  charCounts: Record<string, number>;
  aiRatios: Record<string, number>;
  showWordCounts: boolean;
  showStatusDots: boolean;
  showLabelDots: boolean;
  showAiAttribution: boolean;
  dropIndicator: DropIndicator | null;
  nodeTotals: Record<string, number>;
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
  charCounts,
  aiRatios,
  showWordCounts,
  showStatusDots,
  showLabelDots,
  showAiAttribution,
  dropIndicator,
  nodeTotals,
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
        const isLeaf = node.nodeType === "scene" || node.nodeType === "note";
        const count = isLeaf ? (charCounts[id] ?? 0) : (nodeTotals[id] ?? 0);
        return (
          <Fragment key={id}>
            <TreeNodeItem
              node={node}
              depth={depth}
              isActive={node.id === activeSceneId}
              isSelected={selectedIds.includes(id)}
              isExpanded={isExpanded}
              isVisible={visible}
              charCount={count}
              showWordCounts={showWordCounts}
              showStatusDots={showStatusDots}
              showLabelDots={showLabelDots}
              showAiAttribution={showAiAttribution}
              aiRatio={aiRatios[id] ?? 0}
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
                charCounts={charCounts}
                aiRatios={aiRatios}
                showWordCounts={showWordCounts}
                showStatusDots={showStatusDots}
                showLabelDots={showLabelDots}
                showAiAttribution={showAiAttribution}
                dropIndicator={dropIndicator}
                nodeTotals={nodeTotals}
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
