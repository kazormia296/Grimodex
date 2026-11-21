import { cmpKeys } from "./fractionalIndex.js";

export interface ReadingOrderNode {
  id: string;
  parentId: string | null;
  nodeType: string;
  sortOrder: string;
}

export interface ReadingOrderEntry<T extends ReadingOrderNode> {
  node: T;
  /** root 直下を 0 とする folder の入れ子の深さ。DFS の外に置いた node は 0。 */
  depth: number;
}

function compareSiblings(a: ReadingOrderNode, b: ReadingOrderNode): number {
  return cmpKeys(a.sortOrder, b.sortOrder) || cmpKeys(a.id, b.id);
}

/**
 * tree の読む順（DFS の pre-order）に node を並べる。兄弟ごとに sortOrder（同順位は id）で並べ、
 * folder だけを辿る。全体を 1 回の sortOrder で並べ替えるのとは違う。
 *
 * root から届かない node（親が入力に無い・循環・folder でない親の下）は捨てず、
 * root の DFS の後ろに同じ規則で足す（`flattenSceneNodes` の orphan と同じ扱い）。
 * 呼び出し側が先に除いた node（archived など）の下の node も、ここでは orphan になる。
 */
export function orderNodesInReadingOrder<T extends ReadingOrderNode>(
  nodes: readonly T[],
): ReadingOrderEntry<T>[] {
  const ids = new Set(nodes.map((n) => n.id));
  const childrenByParent = new Map<string | null, T[]>();
  for (const node of nodes) {
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort(compareSiblings);
  }

  const emitted = new Set<string>();
  const result: ReadingOrderEntry<T>[] = [];

  const emit = (node: T, depth: number): void => {
    emitted.add(node.id);
    result.push({ node, depth });
    if (node.nodeType === "folder") walk(node.id, depth + 1);
  };
  const walk = (parentId: string | null, depth: number): void => {
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (!emitted.has(child.id)) emit(child, depth);
    }
  };

  walk(null, 0);
  const sorted = [...nodes].sort(compareSiblings);
  for (const node of sorted) {
    if (
      !emitted.has(node.id) &&
      node.parentId !== null &&
      !ids.has(node.parentId)
    ) {
      emit(node, 0);
    }
  }
  for (const node of sorted) {
    if (!emitted.has(node.id)) emit(node, 0);
  }
  return result;
}
