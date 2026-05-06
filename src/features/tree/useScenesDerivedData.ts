import { useMemo } from "react";
import { cmpKeys } from "./fractionalIndex";
import { flattenVisible } from "./treeVisibility";
import type { TreeNodeData, SortMode } from "./treeStore";

const STATUS_SORT_ORDER: Record<string, number> = {
  outline: 0,
  draft: 1,
  complete: 2,
  revision: 3,
  final: 4,
};

interface DerivedData {
  childMap: Record<string, string[]>;
  nodeMap: Record<string, TreeNodeData>;
  nodeTotals: Record<string, number>;
  flatNodes: TreeNodeData[];
}

/** Pure derivations from tree state — sort, child grouping, totals, and the
 *  flat visible list used by keyboard nav and the bottom drop zone. */
export function useScenesDerivedData(args: {
  nodes: TreeNodeData[];
  sortMode: SortMode;
  charCounts: Record<string, number>;
  expandedIds: string[];
  filterQuery: string;
  statusFilter: string | null;
  labelFilter: string[];
  nodeLabels: Record<string, string[]>;
}): DerivedData {
  const {
    nodes,
    sortMode,
    charCounts,
    expandedIds,
    filterQuery,
    statusFilter,
    labelFilter,
    nodeLabels,
  } = args;

  const { childMap, nodeMap } = useMemo(() => {
    const nm: Record<string, TreeNodeData> = {};
    const cm: Record<string, string[]> = { root: [] };
    for (const n of nodes) nm[n.id] = n;

    let sorted = [...nodes].sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

    if (sortMode !== "manual") {
      sorted = sorted.sort((a, b) => {
        const aIsLeaf = a.nodeType === "scene" || a.nodeType === "note";
        const bIsLeaf = b.nodeType === "scene" || b.nodeType === "note";
        if (!aIsLeaf || !bIsLeaf || a.parentId !== b.parentId) {
          return cmpKeys(a.sortOrder, b.sortOrder);
        }
        if (sortMode === "title") {
          return a.title.localeCompare(b.title, "ja");
        }
        if (sortMode === "wordcount") {
          return (charCounts[b.id] ?? 0) - (charCounts[a.id] ?? 0);
        }
        if (sortMode === "status") {
          return (
            (STATUS_SORT_ORDER[a.status ?? "outline"] ?? 0) -
            (STATUS_SORT_ORDER[b.status ?? "outline"] ?? 0)
          );
        }
        return 0;
      });
    }

    for (const n of sorted) {
      const key = n.parentId ?? "root";
      if (!cm[key]) cm[key] = [];
      cm[key].push(n.id);
    }
    return { childMap: cm, nodeMap: nm };
  }, [nodes, sortMode, charCounts]);

  const nodeTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    function sumDescendants(id: string): number {
      const node = nodeMap[id];
      if (!node) return 0;
      if (node.nodeType === "scene" || node.nodeType === "note") {
        return charCounts[id] ?? 0;
      }
      let total = 0;
      for (const childId of childMap[id] ?? []) {
        total += sumDescendants(childId);
      }
      totals[id] = total;
      return total;
    }
    for (const id of childMap["root"] ?? []) sumDescendants(id);
    return totals;
  }, [nodeMap, childMap, charCounts]);

  const flatNodes = useMemo(
    () =>
      flattenVisible(
        null,
        childMap,
        nodeMap,
        expandedIds,
        filterQuery.toLowerCase(),
        statusFilter,
        labelFilter,
        nodeLabels,
      ),
    [
      childMap,
      nodeMap,
      expandedIds,
      filterQuery,
      statusFilter,
      labelFilter,
      nodeLabels,
    ],
  );

  return { childMap, nodeMap, nodeTotals, flatNodes };
}
