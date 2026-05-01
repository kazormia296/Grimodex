import type { TreeNodeData } from "@/features/tree/treeStore";

export interface MatrixRow {
  node: TreeNodeData;
  depth: number;
  isFolder: boolean;
}

/**
 * Build an ordered, depth-aware list of visible rows from the flat tree nodes.
 *
 * Rules:
 * - Children of collapsed folders are hidden.
 * - When searchQuery is non-empty, only rows whose title matches (or whose
 *   descendants match) are included; matching Scene rows cause their ancestor
 *   folders to appear even if otherwise unmatched.
 */
export function deriveRows(
  nodes: TreeNodeData[],
  collapsedIds: Set<string>,
  searchQuery: string | null,
): MatrixRow[] {
  // Build parent→children map
  const childrenOf = new Map<string | null, TreeNodeData[]>();
  for (const n of nodes) {
    const parentKey = n.parentId ?? null;
    if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
    childrenOf.get(parentKey)!.push(n);
  }

  // Sort each bucket by sortOrder
  for (const bucket of childrenOf.values()) {
    bucket.sort((a, b) => a.sortOrder.localeCompare(b.sortOrder));
  }

  const q = searchQuery?.trim().toLowerCase() ?? "";

  // Pre-compute set of node ids whose subtree contains a match (for search)
  const matchingSubtreeIds = q
    ? computeMatchingSubtreeIds(nodes, childrenOf, q)
    : null;

  const result: MatrixRow[] = [];

  function walk(parentId: string | null, depth: number) {
    const children = childrenOf.get(parentId) ?? [];
    for (const node of children) {
      if (matchingSubtreeIds && !matchingSubtreeIds.has(node.id)) continue;

      result.push({ node, depth, isFolder: node.nodeType === "folder" });

      if (node.nodeType === "folder" && !collapsedIds.has(node.id)) {
        walk(node.id, depth + 1);
      }
    }
  }

  walk(null, 0);
  return result;
}

/** Return ids of all nodes that directly match OR have a matching descendant. */
function computeMatchingSubtreeIds(
  nodes: TreeNodeData[],
  childrenOf: Map<string | null, TreeNodeData[]>,
  q: string,
): Set<string> {
  const directMatch = new Set<string>(
    nodes.filter((n) => n.title.toLowerCase().includes(q)).map((n) => n.id),
  );

  const result = new Set<string>(directMatch);

  // For each direct match, walk up ancestors and add them too
  const parentOf = new Map<string, string | null>();
  for (const n of nodes) parentOf.set(n.id, n.parentId ?? null);

  for (const id of directMatch) {
    let cur: string | null = parentOf.get(id) ?? null;
    while (cur !== null) {
      if (result.has(cur)) break; // already added, ancestors are too
      result.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
  }

  // Also include all descendants of a folder that directly matched
  function addDescendants(nodeId: string) {
    for (const child of childrenOf.get(nodeId) ?? []) {
      result.add(child.id);
      addDescendants(child.id);
    }
  }
  for (const id of directMatch) {
    const node = nodes.find((n) => n.id === id);
    if (node?.nodeType === "folder") addDescendants(id);
  }

  return result;
}
