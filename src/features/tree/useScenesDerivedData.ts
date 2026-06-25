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
  /** For each folder id, the flat list of leaf (scene/note) descendant ids.
   *  Used by TreeNodeItem to compute its own running total via a per-id
   *  charCounts selector — this avoids passing the live charCounts map down
   *  through every render and re-rendering the whole tree on each keystroke. */
  leafDescendantsByFolder: Record<string, string[]>;
  flatNodes: TreeNodeData[];
}

/** Pure derivations from tree state — sort, child grouping, leaf-descendant
 *  index per folder, and the flat visible list used by keyboard nav and the
 *  bottom drop zone. charCounts is only consumed when sortMode === "wordcount";
 *  totals are computed reactively per-folder inside TreeNodeItem. */
export function useScenesDerivedData(args: {
  nodes: TreeNodeData[];
  sortMode: SortMode;
  /** Only read when sortMode === "wordcount". Pass an empty object otherwise
   *  to keep the derivation stable across keystrokes. */
  charCounts: Record<string, number>;
  expandedIds: string[];
  filterQuery: string;
  statusFilter: string | null;
  labelFilter: string[];
  nodeLabels: Record<string, string[]>;
  threadFilter: string[];
  nodeThreadIds: Record<string, string[]>;
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
    threadFilter,
    nodeThreadIds,
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

  const leafDescendantsByFolder = useMemo(() => {
    const result: Record<string, string[]> = {};
    function collect(id: string): string[] {
      const node = nodeMap[id];
      if (!node) return [];
      if (node.nodeType === "scene" || node.nodeType === "note") {
        return [id];
      }
      const acc: string[] = [];
      for (const childId of childMap[id] ?? []) {
        acc.push(...collect(childId));
      }
      result[id] = acc;
      return acc;
    }
    for (const id of childMap["root"] ?? []) collect(id);
    return result;
  }, [nodeMap, childMap]);

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
        threadFilter,
        nodeThreadIds,
      ),
    [
      childMap,
      nodeMap,
      expandedIds,
      filterQuery,
      statusFilter,
      labelFilter,
      nodeLabels,
      threadFilter,
      nodeThreadIds,
    ],
  );

  return { childMap, nodeMap, leafDescendantsByFolder, flatNodes };
}
