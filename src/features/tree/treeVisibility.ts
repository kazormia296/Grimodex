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

export function isNodeVisible(
  node: TreeNodeData,
  childMap: Record<string, string[]>,
  nodeMap: Record<string, TreeNodeData>,
  query: string,
  statusFilter?: string | null,
  labelFilter?: string[],
  nodeLabels?: Record<string, string[]>,
): boolean {
  if (
    statusFilter &&
    node.nodeType === "scene" &&
    node.status !== statusFilter
  ) {
    return false;
  }
  // Label filter (OR semantics): hide leaf nodes that don't carry any selected
  // label. Folders pass through so they remain navigable.
  if (
    labelFilter &&
    labelFilter.length > 0 &&
    (node.nodeType === "scene" || node.nodeType === "note")
  ) {
    const assigned = nodeLabels?.[node.id] ?? [];
    if (!labelFilter.some((id) => assigned.includes(id))) return false;
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
        ),
      );
    }
  }
  return result;
}
