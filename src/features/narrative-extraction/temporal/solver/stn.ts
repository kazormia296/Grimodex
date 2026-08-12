import type { CompiledDifferenceConstraint } from "./compileConstraints";

const INF = Number.POSITIVE_INFINITY;

export interface StnEdge {
  readonly from: number;
  readonly to: number;
  readonly weight: number;
  readonly constraintId: string;
}

export interface StnGraph {
  readonly variableKeys: readonly string[];
  readonly indexOf: ReadonlyMap<string, number>;
  readonly edges: readonly StnEdge[];
  /** All-pairs shortest paths; null if inconsistent */
  readonly distances: number[][] | null;
  readonly negativeCycle: readonly StnEdge[] | null;
}

export function buildStnGraph(
  variableKeys: readonly string[],
  differences: readonly CompiledDifferenceConstraint[],
): StnGraph {
  const keys = [...variableKeys].sort((a, b) => a.localeCompare(b));
  const indexOf = new Map(keys.map((key, i) => [key, i]));
  const n = keys.length;
  const edges: StnEdge[] = [];

  for (const diff of differences) {
    const from = indexOf.get(diff.fromKey);
    const to = indexOf.get(diff.toKey);
    if (from === undefined || to === undefined) continue;
    edges.push({
      from,
      to,
      weight: diff.weight,
      constraintId: diff.sourceConstraintId,
    });
  }

  // Floyd-Warshall
  const dist: number[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => INF),
  );
  for (let i = 0; i < n; i++) dist[i]![i] = 0;
  for (const edge of edges) {
    dist[edge.from]![edge.to] = Math.min(dist[edge.from]![edge.to]!, edge.weight);
  }

  const next: (number | null)[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => null),
  );
  for (const edge of edges) {
    if (next[edge.from]![edge.to] === null) {
      next[edge.from]![edge.to] = edge.to;
    }
  }
  for (let i = 0; i < n; i++) next[i]![i] = i;

  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const via = dist[i]![k]! + dist[k]![j]!;
        if (via < dist[i]![j]!) {
          dist[i]![j] = via;
          next[i]![j] = next[i]![k]!;
        }
      }
    }
  }

  let cycleNode: number | null = null;
  for (let i = 0; i < n; i++) {
    if (dist[i]![i]! < 0) {
      cycleNode = i;
      break;
    }
  }

  if (cycleNode === null) {
    return {
      variableKeys: keys,
      indexOf,
      edges,
      distances: dist,
      negativeCycle: null,
    };
  }

  // Reconstruct a negative cycle involving cycleNode using predecessor edges.
  const cycle = extractNegativeCycle(keys, edges, dist, cycleNode);
  return {
    variableKeys: keys,
    indexOf,
    edges,
    distances: null,
    negativeCycle: cycle,
  };
}

function extractNegativeCycle(
  keys: readonly string[],
  edges: readonly StnEdge[],
  dist: number[][],
  start: number,
): StnEdge[] {
  const n = keys.length;
  // Bellman-Ford parent tracking on edges that participate in shortest paths
  const parent: (StnEdge | null)[] = Array.from({ length: n }, () => null);
  const d = Array.from({ length: n }, () => INF);
  d[start] = 0;
  let updated = start;
  for (let iter = 0; iter < n; iter++) {
    for (const edge of edges) {
      if (d[edge.from]! + edge.weight < d[edge.to]!) {
        d[edge.to] = d[edge.from]! + edge.weight;
        parent[edge.to] = edge;
        updated = edge.to;
      }
    }
  }
  // Walk back n steps to enter the cycle, then collect until repeat
  let x = updated;
  for (let i = 0; i < n; i++) {
    const edge = parent[x];
    if (!edge) break;
    x = edge.from;
  }
  const cycle: StnEdge[] = [];
  const seen = new Set<number>();
  let cur = x;
  while (!seen.has(cur)) {
    seen.add(cur);
    const edge = parent[cur];
    if (!edge) break;
    cycle.push(edge);
    cur = edge.from;
    if (cur === x && cycle.length > 0) break;
  }
  // Prefer edges that explain negative diagonal if cycle empty
  if (cycle.length === 0) {
    return edges.filter(
      (edge) =>
        dist[edge.from]![edge.to]! <= edge.weight &&
        dist[edge.to]![edge.to]! < 0,
    );
  }
  return cycle.reverse();
}

export function boundFromDistances(
  distances: number[][],
  index: number,
): { earliest: number | null; latest: number | null } {
  // With only relative constraints, absolute earliest/latest stay null unless
  // we add origin. Absolute bounds are applied separately in propagate.
  void distances;
  void index;
  return { earliest: null, latest: null };
}
