import type { TreeNodeData } from "./treeStore";

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
    const expanded =
      expandedIds.includes(id) ||
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
