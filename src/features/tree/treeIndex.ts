import { cmpKeys } from "./fractionalIndex";
import type { TreeNodeData } from "./treeStore";

export interface TreeIndex {
  nodeById: ReadonlyMap<string, TreeNodeData>;
  childrenByParent: ReadonlyMap<string | null, readonly TreeNodeData[]>;
  /** Folder id -> number of scene descendants (notes are intentionally excluded). */
  descendantSceneCount: ReadonlyMap<string, number>;
  /** Folder id -> persisted character total for scene/note descendants. */
  descendantCharCount: ReadonlyMap<string, number>;
  /** Folder id -> scene descendants in display order. */
  subtreeSceneIds: ReadonlyMap<string, readonly string[]>;
  /** Folder id -> scene/note descendants in display order. */
  leafDescendantIds: ReadonlyMap<string, readonly string[]>;
}

type NodeComparator = (a: TreeNodeData, b: TreeNodeData) => number;

const defaultIndexCache = new WeakMap<readonly TreeNodeData[], TreeIndex>();

function defaultComparator(a: TreeNodeData, b: TreeNodeData): number {
  return cmpKeys(a.sortOrder, b.sortOrder);
}

/**
 * Build the shared, sorted tree index and all folder aggregates in one
 * post-order traversal. Consumers must not filter the full node array per
 * folder; all child and subtree access goes through this index.
 */
export function buildTreeIndex(
  nodes: readonly TreeNodeData[],
  compare: NodeComparator = defaultComparator,
): TreeIndex {
  const nodeById = new Map<string, TreeNodeData>();
  const childrenByParent = new Map<string | null, TreeNodeData[]>();

  for (const node of nodes) {
    nodeById.set(node.id, node);
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort(compare);
  }

  const descendantSceneCount = new Map<string, number>();
  const descendantCharCount = new Map<string, number>();
  const subtreeSceneIds = new Map<string, readonly string[]>();
  const leafDescendantIds = new Map<string, readonly string[]>();
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const aggregateFolder = (folderId: string): void => {
    if (visited.has(folderId) || visiting.has(folderId)) return;
    visiting.add(folderId);

    let sceneCount = 0;
    let charCount = 0;
    const sceneIds: string[] = [];
    const leafIds: string[] = [];

    for (const child of childrenByParent.get(folderId) ?? []) {
      if (child.nodeType === "folder") {
        aggregateFolder(child.id);
        sceneCount += descendantSceneCount.get(child.id) ?? 0;
        charCount += descendantCharCount.get(child.id) ?? 0;
        sceneIds.push(...(subtreeSceneIds.get(child.id) ?? []));
        leafIds.push(...(leafDescendantIds.get(child.id) ?? []));
        continue;
      }

      leafIds.push(child.id);
      charCount += child.charCount ?? 0;
      if (child.nodeType === "scene") {
        sceneCount += 1;
        sceneIds.push(child.id);
      }
    }

    visiting.delete(folderId);
    visited.add(folderId);
    descendantSceneCount.set(folderId, sceneCount);
    descendantCharCount.set(folderId, charCount);
    subtreeSceneIds.set(folderId, sceneIds);
    leafDescendantIds.set(folderId, leafIds);
  };

  for (const node of nodes) {
    if (node.nodeType === "folder") aggregateFolder(node.id);
  }

  return {
    nodeById,
    childrenByParent,
    descendantSceneCount,
    descendantCharCount,
    subtreeSceneIds,
    leafDescendantIds,
  };
}

/** Cached manual-order index shared by Grid, Linear and other tree readers. */
export function getTreeIndex(nodes: readonly TreeNodeData[]): TreeIndex {
  const cached = defaultIndexCache.get(nodes);
  if (cached) return cached;
  const index = buildTreeIndex(nodes);
  defaultIndexCache.set(nodes, index);
  return index;
}

interface LiveFolderTotals {
  nodes: readonly TreeNodeData[];
  totals: ReadonlyMap<string, number>;
}

const liveFolderTotalsCache = new WeakMap<
  Record<string, number>,
  LiveFolderTotals
>();

/**
 * One O(nodes) post-order pass per charCounts revision, shared by every folder
 * row selector. Previously every mounted folder independently scanned its
 * materialized descendant array on every character-count update.
 */
export function getLiveFolderCharCount(
  nodes: readonly TreeNodeData[],
  charCounts: Record<string, number>,
  folderId: string,
): number {
  const cached = liveFolderTotalsCache.get(charCounts);
  if (cached?.nodes === nodes) return cached.totals.get(folderId) ?? 0;

  const index = getTreeIndex(nodes);
  const totals = new Map<string, number>();
  const visiting = new Set<string>();

  const totalFor = (id: string): number => {
    const existing = totals.get(id);
    if (existing !== undefined) return existing;
    if (visiting.has(id)) return 0;
    visiting.add(id);

    let total = 0;
    for (const child of index.childrenByParent.get(id) ?? []) {
      total +=
        child.nodeType === "folder"
          ? totalFor(child.id)
          : (charCounts[child.id] ?? 0);
    }

    visiting.delete(id);
    totals.set(id, total);
    return total;
  };

  for (const node of nodes) {
    if (node.nodeType === "folder") totalFor(node.id);
  }
  liveFolderTotalsCache.set(charCounts, { nodes, totals });
  return totals.get(folderId) ?? 0;
}

/** Scene-only DFS order used by Linear Editor. Unreachable scenes are kept. */
export function flattenSceneNodes(index: TreeIndex): TreeNodeData[] {
  const result: TreeNodeData[] = [];
  const visitedFolders = new Set<string>();

  const walk = (parentId: string | null): void => {
    for (const node of index.childrenByParent.get(parentId) ?? []) {
      if (node.nodeType === "scene") {
        result.push(node);
      } else if (node.nodeType === "folder" && !visitedFolders.has(node.id)) {
        visitedFolders.add(node.id);
        walk(node.id);
      }
    }
  };
  walk(null);

  const seen = new Set(result.map((node) => node.id));
  const orphans = [...index.nodeById.values()]
    .filter((node) => node.nodeType === "scene" && !seen.has(node.id))
    .sort(defaultComparator);
  return orphans.length === 0 ? result : [...result, ...orphans];
}
