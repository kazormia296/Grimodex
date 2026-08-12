import type { TemporalVariableDomain } from "../resolution";
import type {
  CompiledAbsoluteBound,
  CompiledDifferenceConstraint,
  StnVariable,
} from "./compileConstraints";
import { buildStnGraph, type StnGraph } from "./stn";

export interface PropagateInput {
  readonly variables: readonly StnVariable[];
  readonly differences: readonly CompiledDifferenceConstraint[];
  readonly absolutes: readonly CompiledAbsoluteBound[];
}

export type PropagateResult =
  | {
      readonly ok: true;
      readonly domains: ReadonlyMap<string, TemporalVariableDomain>;
      readonly graph: StnGraph;
      readonly emptyDomainKeys: readonly string[];
    }
  | {
      readonly ok: false;
      readonly graph: StnGraph;
      readonly domains: ReadonlyMap<string, TemporalVariableDomain>;
      readonly emptyDomainKeys: readonly string[];
      readonly conflictingConstraintIds: readonly string[];
    };

function intersect(
  a: TemporalVariableDomain,
  b: TemporalVariableDomain,
): TemporalVariableDomain | "empty" {
  const earliest =
    a.earliest === null
      ? b.earliest
      : b.earliest === null
        ? a.earliest
        : Math.max(a.earliest, b.earliest);
  const latest =
    a.latest === null
      ? b.latest
      : b.latest === null
        ? a.latest
        : Math.min(a.latest, b.latest);
  if (earliest !== null && latest !== null && earliest > latest) return "empty";
  return { earliest, latest };
}

/**
 * Bound propagation for difference constraints x - y <= c:
 *   latest[x] = min(latest[x], latest[y] + c)
 *   earliest[y] = max(earliest[y], earliest[x] - c)
 */
export function propagateDomains(input: PropagateInput): PropagateResult {
  const graph = buildStnGraph(
    input.variables.map((v) => v.key),
    input.differences,
  );

  const domains = new Map<string, TemporalVariableDomain>();
  for (const variable of input.variables) {
    domains.set(variable.key, { earliest: null, latest: null });
  }

  const absByKey = new Map<string, string[]>();
  for (const abs of [...input.absolutes].sort((a, b) =>
    a.variableKey.localeCompare(b.variableKey),
  )) {
    const list = absByKey.get(abs.variableKey) ?? [];
    list.push(abs.sourceConstraintId);
    absByKey.set(abs.variableKey, list);
    const current = domains.get(abs.variableKey) ?? {
      earliest: null,
      latest: null,
    };
    const next = intersect(current, {
      earliest: abs.earliest,
      latest: abs.latest,
    });
    if (next === "empty") {
      return {
        ok: false,
        graph,
        domains,
        emptyDomainKeys: [abs.variableKey],
        conflictingConstraintIds: [
          ...new Set([
            ...(absByKey.get(abs.variableKey) ?? []),
            abs.sourceConstraintId,
          ]),
        ].sort((a, b) => a.localeCompare(b)),
      };
    }
    domains.set(abs.variableKey, next);
  }

  if (graph.distances === null) {
    return {
      ok: false,
      graph,
      domains,
      emptyDomainKeys: [],
      conflictingConstraintIds: [
        ...new Set(graph.negativeCycle?.map((e) => e.constraintId) ?? []),
      ].sort((a, b) => a.localeCompare(b)),
    };
  }

  let changed = true;
  let guard = 0;
  const maxIter = Math.max(
    64,
    input.variables.length * input.variables.length + 8,
  );
  while (changed && guard++ < maxIter) {
    changed = false;
    for (const diff of input.differences) {
      const x = domains.get(diff.toKey);
      const y = domains.get(diff.fromKey);
      if (!x || !y) continue;

      // x - y <= c
      let nextX = x;
      let nextY = y;
      if (y.latest !== null) {
        const cand: TemporalVariableDomain = {
          earliest: x.earliest,
          latest:
            x.latest === null
              ? y.latest + diff.weight
              : Math.min(x.latest, y.latest + diff.weight),
        };
        const merged = intersect(x, cand);
        if (merged === "empty") {
          return {
            ok: false,
            graph,
            domains,
            emptyDomainKeys: [diff.toKey],
            conflictingConstraintIds: [diff.sourceConstraintId],
          };
        }
        if (merged.earliest !== x.earliest || merged.latest !== x.latest) {
          nextX = merged;
          changed = true;
        }
      }
      if (x.earliest !== null) {
        const cand: TemporalVariableDomain = {
          earliest:
            y.earliest === null
              ? x.earliest - diff.weight
              : Math.max(y.earliest, x.earliest - diff.weight),
          latest: y.latest,
        };
        const merged = intersect(y, cand);
        if (merged === "empty") {
          return {
            ok: false,
            graph,
            domains,
            emptyDomainKeys: [diff.fromKey],
            conflictingConstraintIds: [diff.sourceConstraintId],
          };
        }
        if (merged.earliest !== y.earliest || merged.latest !== y.latest) {
          nextY = merged;
          changed = true;
        }
      }
      domains.set(diff.toKey, nextX);
      domains.set(diff.fromKey, nextY);
    }
  }

  return { ok: true, domains, graph, emptyDomainKeys: [] };
}
