import type { TemporalConstraintGraph } from "../graph";
import type { TemporalConstraint } from "../constraints";
import type { TemporalNode, TemporalNodeId } from "../nodes";
import type { TemporalSolverResult, ResolvedTemporalNode } from "../resolution";
import { isExactDomain, MINUTES_PER_DAY } from "../resolution";
import { compileConstraints } from "./compileConstraints";
import { explainNegativeCycle } from "./explainConflict";
import { propagateDomains } from "./propagate";
import { calendarConstraintPass } from "./calendarConstraintPass";

export interface SolveTemporalGraphOptions {
  readonly weekLengthDays?: number | null;
}

function weekLengthFromGraph(graph: TemporalConstraintGraph): number | null {
  const names = graph.calendar?.weekdayNames;
  if (!names || names.length === 0) return null;
  return names.length;
}

function buildResolution(
  nodes: readonly TemporalNode[],
  domains: ReadonlyMap<string, { earliest: number | null; latest: number | null }>,
  derivationByNode: ReadonlyMap<TemporalNodeId, string[]>,
  conflicting: ReadonlySet<TemporalNodeId>,
  symbolic: ReadonlySet<TemporalNodeId>,
): ResolvedTemporalNode[] {
  return [...nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => {
      if (conflicting.has(node.id)) {
        return {
          nodeId: node.id,
          resolution: "contradictory" as const,
          actualStart: { earliest: null, latest: null },
          actualEnd: null,
          duration: null,
          uncertaintyReason: ["conflict"],
          derivationConstraintIds: derivationByNode.get(node.id) ?? [],
        };
      }
      if (symbolic.has(node.id)) {
        return {
          nodeId: node.id,
          resolution: "symbolic" as const,
          actualStart: { earliest: null, latest: null },
          actualEnd: null,
          duration: null,
          uncertaintyReason: ["symbolic-constraint"],
          derivationConstraintIds: derivationByNode.get(node.id) ?? [],
        };
      }
      const start = domains.get(`${node.id}#start`) ?? {
        earliest: null,
        latest: null,
      };
      const end = domains.get(`${node.id}#end`) ?? {
        earliest: null,
        latest: null,
      };
      const hasAny =
        start.earliest !== null ||
        start.latest !== null ||
        end.earliest !== null ||
        end.latest !== null;
      let resolution: ResolvedTemporalNode["resolution"] = "ordered-only";
      if (!hasAny) resolution = "ordered-only";
      else if (isExactDomain(start) && (node.shape === "point" || isExactDomain(end))) {
        resolution = "exact";
      } else if (start.earliest !== null || start.latest !== null) {
        resolution = "bounded";
      }

      const duration =
        start.earliest !== null &&
        end.latest !== null &&
        start.latest !== null &&
        end.earliest !== null
          ? {
              earliest: end.earliest - start.latest,
              latest: end.latest - start.earliest,
            }
          : null;

      return {
        nodeId: node.id,
        resolution,
        actualStart: start,
        actualEnd: node.shape === "point" ? null : end,
        duration,
        uncertaintyReason:
          resolution === "bounded"
            ? ["non-unique-start-or-end"]
            : [],
        derivationConstraintIds: derivationByNode.get(node.id) ?? [],
      };
    });
}

function derivationMap(
  constraints: readonly TemporalConstraint[],
): Map<TemporalNodeId, string[]> {
  const map = new Map<TemporalNodeId, string[]>();
  const add = (nodeId: TemporalNodeId, id: string) => {
    const list = map.get(nodeId) ?? [];
    list.push(id);
    map.set(nodeId, list);
  };
  for (const c of constraints) {
    switch (c.kind) {
      case "absolute-window":
      case "duration":
      case "symbolic":
        add(c.nodeId, c.id);
        break;
      case "relative-offset":
        add(c.left.nodeId, c.id);
        add(c.right.nodeId, c.id);
        break;
      case "interval-relation":
        add(c.leftNodeId, c.id);
        add(c.rightNodeId, c.id);
        break;
    }
  }
  for (const [k, v] of map) {
    map.set(k, [...new Set(v)].sort((a, b) => a.localeCompare(b)));
  }
  return map;
}

function solveOnce(
  graph: TemporalConstraintGraph,
  includeSoft: boolean,
  weekLengthDays: number | null,
): {
  resolutions: ResolvedTemporalNode[];
  conflicts: TemporalSolverResult["conflicts"];
  graph: ReturnType<typeof propagateDomains>["graph"];
  ok: boolean;
} {
  const pass = calendarConstraintPass(
    graph.constraints,
    graph.calendar,
    new Map(),
  );
  const compiled = compileConstraints(graph.nodes, pass.expanded, {
    weekLengthDays,
    includeSoft,
  });
  const propagated = propagateDomains({
    variables: compiled.variables,
    differences: compiled.differences,
    absolutes: compiled.absolutes,
  });

  const symbolic = new Set<TemporalNodeId>();
  for (const c of graph.constraints) {
    if (c.kind === "symbolic") symbolic.add(c.nodeId);
  }

  const derivations = derivationMap(graph.constraints);
  if (!propagated.ok) {
    const cycleConflict = explainNegativeCycle(propagated.graph);
    const emptyKeys = propagated.emptyDomainKeys;
    const nodeIdsFromEmpty = emptyKeys
      .map((key) => key.slice(0, key.lastIndexOf("#")) as TemporalNodeId)
      .filter(Boolean);
    const conflict =
      cycleConflict ??
      ({
        conflictId: "conflict:empty-domain",
        constraintIds: propagated.conflictingConstraintIds,
        nodeIds: [...new Set(nodeIdsFromEmpty)].sort((a, b) =>
          a.localeCompare(b),
        ),
        explanation: `Incompatible temporal domains for: ${emptyKeys.join(", ") || propagated.conflictingConstraintIds.join(", ")}`,
        cycle: [],
      } as const);
    // Attach related absolute/relative ids when only one id known
    const allConflictIds = [
      ...new Set([
        ...conflict.constraintIds,
        ...propagated.conflictingConstraintIds,
        ...compiled.absolutes.map((a) => a.sourceConstraintId),
        ...compiled.differences.map((d) => d.sourceConstraintId),
      ]),
    ]
      .filter((id) =>
        graph.constraints.some(
          (c) =>
            c.id === id &&
            (conflict.nodeIds.length === 0 ||
              involvesNode(c, conflict.nodeIds)),
        ),
      )
      .sort((a, b) => a.localeCompare(b));
    const enriched = {
      ...conflict,
      constraintIds:
        allConflictIds.length > 0 ? allConflictIds : conflict.constraintIds,
      nodeIds:
        conflict.nodeIds.length > 0
          ? conflict.nodeIds
          : (graph.nodes.map((n) => n.id) as TemporalNodeId[]),
    };
    const conflicting = new Set<TemporalNodeId>(enriched.nodeIds);
    return {
      ok: false,
      graph: propagated.graph,
      conflicts: [enriched],
      resolutions: buildResolution(
        graph.nodes,
        propagated.domains,
        derivations,
        conflicting,
        symbolic,
      ),
    };
  }

  return {
    ok: true,
    graph: propagated.graph,
    conflicts: [],
    resolutions: buildResolution(
      graph.nodes,
      propagated.domains,
      derivations,
      new Set(),
      symbolic,
    ),
  };
}

function involvesNode(
  constraint: TemporalConstraint,
  nodeIds: readonly TemporalNodeId[],
): boolean {
  const set = new Set(nodeIds);
  switch (constraint.kind) {
    case "absolute-window":
    case "duration":
    case "symbolic":
      return set.has(constraint.nodeId);
    case "relative-offset":
      return set.has(constraint.left.nodeId) || set.has(constraint.right.nodeId);
    case "interval-relation":
      return set.has(constraint.leftNodeId) || set.has(constraint.rightNodeId);
  }
}

/**
 * Deterministic Temporal Constraint Solver.
 * hardResolution uses hard constraints only; suggestedResolution adds soft.
 */
export function solveTemporalGraph(
  graph: TemporalConstraintGraph,
  options: SolveTemporalGraphOptions = {},
): TemporalSolverResult {
  const weekLengthDays =
    options.weekLengthDays !== undefined
      ? options.weekLengthDays
      : weekLengthFromGraph(graph);

  const hard = solveOnce(graph, false, weekLengthDays);
  const soft = solveOnce(graph, true, weekLengthDays);

  const softIds = graph.constraints
    .filter((c) => c.strictness === "soft")
    .map((c) => c.id)
    .sort((a, b) => a.localeCompare(b));

  const violatedSoftConstraintIds =
    !soft.ok && hard.ok
      ? softIds
      : softIds.filter((id) => {
          // Soft violated if hard ok but suggested marks nodes contradictory for that constraint
          return soft.conflicts.some((c) => c.constraintIds.includes(id));
        });

  return {
    hardResolution: hard.resolutions,
    suggestedResolution: soft.resolutions,
    violatedSoftConstraintIds,
    conflicts: hard.conflicts,
  };
}

export { MINUTES_PER_DAY };
