import type { TreeNodeData } from "./treeStore";
import type { TreeIndex } from "./treeIndex";

export interface VisibleTreeRow {
  node: TreeNodeData;
  depth: number;
}

export interface VisibleTreeOptions {
  expandedIds: readonly string[];
  query: string;
  statusFilter?: string | null;
  labelFilter?: readonly string[];
  nodeLabels?: Record<string, string[]>;
  threadFilter?: readonly string[];
  nodeThreadIds?: Record<string, string[]>;
}

/**
 * Calculate every visibility propagation bit once, then flatten in one DFS.
 * This is the indexed path used by ScenesPanel. The legacy per-node helpers
 * below remain exported for small standalone consumers and compatibility.
 */
export function deriveVisibleTreeRows(
  index: TreeIndex,
  options: VisibleTreeOptions,
): VisibleTreeRow[] {
  const {
    expandedIds,
    query,
    statusFilter,
    labelFilter = [],
    nodeLabels = {},
    threadFilter = [],
    nodeThreadIds = {},
  } = options;
  const normalizedQuery = query.toLowerCase();
  const expanded = new Set(expandedIds);
  const labelIds = new Set(labelFilter);
  const threadIds = new Set(threadFilter);
  const queryActive = normalizedQuery.length > 0;
  const threadActive = threadIds.size > 0;
  const subtreeTitleMatch = new Map<string, boolean>();
  const subtreeThreadMatch = new Map<string, boolean>();
  const visiting = new Set<string>();

  const assignedMatches = (
    assignments: readonly string[] | undefined,
    selected: ReadonlySet<string>,
  ): boolean => assignments?.some((id) => selected.has(id)) ?? false;

  const collectPropagation = (node: TreeNodeData): void => {
    if (subtreeTitleMatch.has(node.id) || visiting.has(node.id)) return;
    visiting.add(node.id);

    let titleMatch =
      queryActive && node.title.toLowerCase().includes(normalizedQuery);
    let threadMatch =
      (node.nodeType === "scene" || node.nodeType === "note") &&
      threadActive &&
      assignedMatches(nodeThreadIds[node.id], threadIds);

    if (node.nodeType === "folder") {
      for (const child of index.childrenByParent.get(node.id) ?? []) {
        collectPropagation(child);
        titleMatch ||= subtreeTitleMatch.get(child.id) ?? false;
        threadMatch ||= subtreeThreadMatch.get(child.id) ?? false;
      }
    }

    visiting.delete(node.id);
    subtreeTitleMatch.set(node.id, titleMatch);
    subtreeThreadMatch.set(node.id, threadMatch);
  };

  for (const node of index.nodeById.values()) collectPropagation(node);

  const isVisible = (node: TreeNodeData): boolean => {
    if (
      statusFilter &&
      node.nodeType === "scene" &&
      node.status !== statusFilter
    ) {
      return false;
    }
    const isLeaf = node.nodeType === "scene" || node.nodeType === "note";
    if (
      labelIds.size > 0 &&
      isLeaf &&
      !assignedMatches(nodeLabels[node.id], labelIds)
    ) {
      return false;
    }
    if (threadActive) {
      if (isLeaf) {
        if (!assignedMatches(nodeThreadIds[node.id], threadIds)) return false;
      } else if (!(subtreeThreadMatch.get(node.id) ?? false)) {
        return false;
      }
    }
    return !queryActive || (subtreeTitleMatch.get(node.id) ?? false);
  };

  const rows: VisibleTreeRow[] = [];
  const walkedFolders = new Set<string>();
  const flatten = (parentId: string | null, depth: number): void => {
    for (const node of index.childrenByParent.get(parentId) ?? []) {
      if (!isVisible(node)) continue;
      rows.push({ node, depth });
      if (
        node.nodeType === "folder" &&
        !walkedFolders.has(node.id) &&
        (expanded.has(node.id) || queryActive || threadActive)
      ) {
        walkedFolders.add(node.id);
        flatten(node.id, depth + 1);
      }
    }
  };
  flatten(null, 0);
  return rows;
}

function hasMatchingDescendant(
  id: string,
  childMap: Record<string, string[]>,
  nodeMap: Record<string, TreeNodeData>,
  query: string,
): boolean {
  for (const childId of childMap[id] ?? []) {
    const child = nodeMap[childId];
    if (child && child.title.toLowerCase().includes(query)) return true;
    if (hasMatchingDescendant(childId, childMap, nodeMap, query)) return true;
  }
  return false;
}

/** OR-match a leaf node's plot-thread membership against the active filter. */
function matchesThreadFilter(
  nodeId: string,
  threadFilter: string[],
  nodeThreadIds?: Record<string, string[]>,
): boolean {
  const assigned = nodeThreadIds?.[nodeId] ?? [];
  return threadFilter.some((id) => assigned.includes(id));
}

/** True when a folder has at least one descendant leaf matching the thread
 *  filter. Unlike the label filter (which passes folders through), the thread
 *  filter hides chapters that don't contain any of the selected subplots so the
 *  tree collapses to just the relevant storyline. */
function hasMatchingThreadDescendant(
  id: string,
  childMap: Record<string, string[]>,
  nodeMap: Record<string, TreeNodeData>,
  threadFilter: string[],
  nodeThreadIds?: Record<string, string[]>,
): boolean {
  for (const childId of childMap[id] ?? []) {
    const child = nodeMap[childId];
    if (!child) continue;
    if (
      (child.nodeType === "scene" || child.nodeType === "note") &&
      matchesThreadFilter(childId, threadFilter, nodeThreadIds)
    ) {
      return true;
    }
    if (
      hasMatchingThreadDescendant(
        childId,
        childMap,
        nodeMap,
        threadFilter,
        nodeThreadIds,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function isNodeVisible(
  node: TreeNodeData,
  childMap: Record<string, string[]>,
  nodeMap: Record<string, TreeNodeData>,
  query: string,
  statusFilter?: string | null,
  labelFilter?: string[],
  nodeLabels?: Record<string, string[]>,
  threadFilter?: string[],
  nodeThreadIds?: Record<string, string[]>,
): boolean {
  if (
    statusFilter &&
    node.nodeType === "scene" &&
    node.status !== statusFilter
  ) {
    return false;
  }
  const isLeaf = node.nodeType === "scene" || node.nodeType === "note";
  // Label filter (OR semantics): hide leaf nodes that don't carry any selected
  // label. Folders pass through so they remain navigable.
  if (labelFilter && labelFilter.length > 0 && isLeaf) {
    const assigned = nodeLabels?.[node.id] ?? [];
    if (!labelFilter.some((id) => assigned.includes(id))) return false;
  }
  // Plot-thread filter (OR semantics). Leaves are hidden when not in any
  // selected subplot; folders are hidden unless they contain a matching leaf
  // (collapses the tree to the relevant storyline — see hasMatchingThreadDescendant).
  if (threadFilter && threadFilter.length > 0) {
    if (isLeaf) {
      if (!matchesThreadFilter(node.id, threadFilter, nodeThreadIds)) {
        return false;
      }
    } else if (
      !hasMatchingThreadDescendant(
        node.id,
        childMap,
        nodeMap,
        threadFilter,
        nodeThreadIds,
      )
    ) {
      return false;
    }
  }
  if (!query) return true;
  if (node.title.toLowerCase().includes(query)) return true;
  return hasMatchingDescendant(node.id, childMap, nodeMap, query);
}

/** Build a flat list of visible nodes in display order, used for keyboard nav. */
export function flattenVisible(
  parentId: string | null,
  childMap: Record<string, string[]>,
  nodeMap: Record<string, TreeNodeData>,
  expandedIds: string[],
  query: string,
  statusFilter?: string | null,
  labelFilter?: string[],
  nodeLabels?: Record<string, string[]>,
  threadFilter?: string[],
  nodeThreadIds?: Record<string, string[]>,
): TreeNodeData[] {
  const ids = childMap[parentId ?? "root"] ?? [];
  const result: TreeNodeData[] = [];
  for (const id of ids) {
    const node = nodeMap[id];
    if (!node) continue;
    if (
      !isNodeVisible(
        node,
        childMap,
        nodeMap,
        query,
        statusFilter,
        labelFilter,
        nodeLabels,
        threadFilter,
        nodeThreadIds,
      )
    )
      continue;
    result.push(node);
    const isContainer = node.nodeType === "folder";
    // Thread filter hides non-matching folders, so auto-expand the survivors to
    // reveal the subplot's scenes (same spirit as search auto-expand).
    const threadFilterActive = !!threadFilter && threadFilter.length > 0;
    const expanded =
      expandedIds.includes(id) ||
      threadFilterActive ||
      (!!query &&
        isNodeVisible(
          node,
          childMap,
          nodeMap,
          query,
          statusFilter,
          labelFilter,
          nodeLabels,
          threadFilter,
          nodeThreadIds,
        ));
    if (isContainer && expanded) {
      result.push(
        ...flattenVisible(
          id,
          childMap,
          nodeMap,
          expandedIds,
          query,
          statusFilter,
          labelFilter,
          nodeLabels,
          threadFilter,
          nodeThreadIds,
        ),
      );
    }
  }
  return result;
}
