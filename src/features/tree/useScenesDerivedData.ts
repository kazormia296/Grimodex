import { useMemo } from "react";
import { cmpKeys } from "./fractionalIndex";
import { deriveVisibleTreeRows, type VisibleTreeRow } from "./treeVisibility";
import { buildTreeIndex, getTreeIndex } from "./treeIndex";
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
  flatRows: VisibleTreeRow[];
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

  const { childMap, nodeMap, index } = useMemo(() => {
    const nm: Record<string, TreeNodeData> = {};
    const cm: Record<string, string[]> = { root: [] };
    for (const n of nodes) nm[n.id] = n;

    const compare = (a: TreeNodeData, b: TreeNodeData): number => {
      if (sortMode !== "manual") {
        const aIsLeaf = a.nodeType === "scene" || a.nodeType === "note";
        const bIsLeaf = b.nodeType === "scene" || b.nodeType === "note";
        if (aIsLeaf && bIsLeaf && a.parentId === b.parentId) {
          let result = 0;
          if (sortMode === "title") {
            result = a.title.localeCompare(b.title, "ja");
          } else if (sortMode === "wordcount") {
            result = (charCounts[b.id] ?? 0) - (charCounts[a.id] ?? 0);
          } else if (sortMode === "status") {
            result =
              (STATUS_SORT_ORDER[a.status ?? "outline"] ?? 0) -
              (STATUS_SORT_ORDER[b.status ?? "outline"] ?? 0);
          }
          if (result !== 0) return result;
        }
      }
      return cmpKeys(a.sortOrder, b.sortOrder);
    };
    const treeIndex =
      sortMode === "manual"
        ? getTreeIndex(nodes)
        : buildTreeIndex(nodes, compare);

    for (const [parentId, children] of treeIndex.childrenByParent) {
      const key = parentId ?? "root";
      if (!cm[key]) cm[key] = [];
      cm[key].push(...children.map((node) => node.id));
    }
    return { childMap: cm, nodeMap: nm, index: treeIndex };
  }, [nodes, sortMode, charCounts]);

  const flatRows = useMemo(
    () =>
      deriveVisibleTreeRows(index, {
        expandedIds,
        query: filterQuery,
        statusFilter,
        labelFilter,
        nodeLabels,
        threadFilter,
        nodeThreadIds,
      }),
    [
      index,
      expandedIds,
      filterQuery,
      statusFilter,
      labelFilter,
      nodeLabels,
      threadFilter,
      nodeThreadIds,
    ],
  );
  const flatNodes = useMemo(() => flatRows.map((row) => row.node), [flatRows]);

  return { childMap, nodeMap, flatRows, flatNodes };
}
