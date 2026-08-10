import type { TemporalNodeId } from "../nodes";

export type StoryCompare =
  | { readonly kind: "before" }
  | { readonly kind: "after" }
  | { readonly kind: "equal" }
  | { readonly kind: "incomparable" };

export interface StoryRankLayer {
  readonly rank: number;
  readonly nodeIds: readonly TemporalNodeId[];
}

export interface StoryRankResult {
  readonly layers: readonly StoryRankLayer[];
  /** Pairwise relation; missing key ⇒ incomparable */
  readonly compare: (
    left: TemporalNodeId,
    right: TemporalNodeId,
  ) => StoryCompare;
  readonly equalTimeGroups: ReadonlyMap<TemporalNodeId, string>;
}

/**
 * Build partial order ranks from a before-or-equal adjacency.
 * Does NOT invent order for incomparable nodes — they may share no layer chain.
 * For materialization, only emit layers when the caller confirms completeness.
 */
export function resolveStoryRanks(
  nodeIds: readonly TemporalNodeId[],
  edges: readonly {
    readonly earlier: TemporalNodeId;
    readonly later: TemporalNodeId;
    readonly equal?: boolean;
  }[],
): StoryRankResult {
  const nodes = [...new Set(nodeIds)].sort((a, b) => a.localeCompare(b));
  const before = new Map<TemporalNodeId, Set<TemporalNodeId>>();
  const equal = new Map<TemporalNodeId, Set<TemporalNodeId>>();
  for (const id of nodes) {
    before.set(id, new Set());
    equal.set(id, new Set([id]));
  }

  for (const edge of [...edges].sort((a, b) =>
    `${a.earlier}:${a.later}`.localeCompare(`${b.earlier}:${b.later}`),
  )) {
    if (!before.has(edge.earlier) || !before.has(edge.later)) continue;
    if (edge.equal) {
      equal.get(edge.earlier)!.add(edge.later);
      equal.get(edge.later)!.add(edge.earlier);
    } else {
      before.get(edge.later)!.add(edge.earlier);
    }
  }

  // Union-find style equal groups
  const parent = new Map<TemporalNodeId, TemporalNodeId>();
  for (const id of nodes) parent.set(id, id);
  const find = (id: TemporalNodeId): TemporalNodeId => {
    let cur = id;
    while (parent.get(cur) !== cur) cur = parent.get(cur)!;
    return cur;
  };
  const union = (a: TemporalNodeId, b: TemporalNodeId): void => {
    const pa = find(a);
    const pb = find(b);
    if (pa === pb) return;
    if (pa < pb) parent.set(pb, pa);
    else parent.set(pa, pb);
  };
  for (const id of nodes) {
    for (const other of equal.get(id) ?? []) union(id, other);
  }

  const equalTimeGroups = new Map<TemporalNodeId, string>();
  for (const id of nodes) {
    equalTimeGroups.set(id, `eq:${find(id)}`);
  }

  // Transitive closure of before on group reps
  const reps = [...new Set(nodes.map(find))].sort((a, b) => a.localeCompare(b));
  const adj = new Map<TemporalNodeId, Set<TemporalNodeId>>();
  for (const r of reps) adj.set(r, new Set());
  for (const later of nodes) {
    for (const earlier of before.get(later) ?? []) {
      const er = find(earlier);
      const lr = find(later);
      if (er !== lr) adj.get(lr)!.add(er);
    }
  }

  // Kahn layers — only among comparable chains; disconnected reps get own ranks
  // by stable sort of rep id among sources repeatedly.
  const indeg = new Map<TemporalNodeId, number>();
  for (const r of reps) indeg.set(r, 0);
  for (const r of reps) {
    for (const pred of adj.get(r) ?? []) {
      // edge pred → r means pred before r; indeg on r
      void pred;
      indeg.set(r, (indeg.get(r) ?? 0) + 1);
    }
  }
  // Fix indeg: count incoming
  for (const r of reps) indeg.set(r, 0);
  for (const r of reps) {
    for (const pred of adj.get(r) ?? []) {
      void pred;
    }
  }
  for (const r of reps) {
    for (const pred of adj.get(r) ?? []) {
      void pred;
    }
  }
  // rebuild indeg properly
  const incoming = new Map<TemporalNodeId, Set<TemporalNodeId>>();
  for (const r of reps) incoming.set(r, new Set());
  for (const r of reps) {
    for (const pred of adj.get(r) ?? []) {
      incoming.get(r)!.add(pred);
    }
  }
  for (const r of reps) indeg.set(r, incoming.get(r)!.size);

  const layers: { rank: number; nodeIds: TemporalNodeId[] }[] = [];
  const remaining = new Set(reps);
  let rank = 0;
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((r) => (indeg.get(r) ?? 0) === 0)
      .sort((a, b) => a.localeCompare(b));
    if (ready.length === 0) {
      // Cycle in story order — leave rest incomparable as single dump layer
      const rest = [...remaining].sort((a, b) => a.localeCompare(b));
      const memberNodes = nodes.filter((id) => rest.includes(find(id)));
      layers.push({ rank, nodeIds: memberNodes });
      break;
    }
    const memberNodes = nodes.filter((id) => ready.includes(find(id)));
    layers.push({ rank, nodeIds: memberNodes });
    for (const r of ready) {
      remaining.delete(r);
      for (const succ of reps) {
        if (incoming.get(succ)?.has(r)) {
          incoming.get(succ)!.delete(r);
          indeg.set(succ, incoming.get(succ)!.size);
        }
      }
    }
    rank += 1;
  }

  const beforeClosure = new Map<TemporalNodeId, Set<TemporalNodeId>>();
  for (const r of reps) beforeClosure.set(r, new Set(incomingReachable(r, adj)));

  function compare(left: TemporalNodeId, right: TemporalNodeId): StoryCompare {
    if (!parent.has(left) || !parent.has(right)) {
      return { kind: "incomparable" };
    }
    const a = find(left);
    const b = find(right);
    if (a === b) return { kind: "equal" };
    // Can we reach a from b's predecessors? Use DFS: is a before b?
    if (isBefore(a, b, adj)) return { kind: "before" };
    if (isBefore(b, a, adj)) return { kind: "after" };
    return { kind: "incomparable" };
  }

  return {
    layers,
    compare,
    equalTimeGroups,
  };
}

function isBefore(
  earlier: TemporalNodeId,
  later: TemporalNodeId,
  adj: Map<TemporalNodeId, Set<TemporalNodeId>>,
): boolean {
  // adj[later] contains direct predecessors; walk preds
  const stack = [...(adj.get(later) ?? [])];
  const seen = new Set<TemporalNodeId>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === earlier) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const pred of adj.get(cur) ?? []) stack.push(pred);
  }
  return false;
}

function incomingReachable(
  _rep: TemporalNodeId,
  _adj: Map<TemporalNodeId, Set<TemporalNodeId>>,
): TemporalNodeId[] {
  return [];
}
