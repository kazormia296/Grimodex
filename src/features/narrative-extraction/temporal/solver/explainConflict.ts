import type { TemporalConflict } from "../conflict";
import type { TemporalEndpointRef } from "../constraints";
import type { TemporalNodeId } from "../nodes";
import type { StnEdge, StnGraph } from "./stn";

function parseEndpoint(key: string): TemporalEndpointRef | null {
  const hash = key.lastIndexOf("#");
  if (hash <= 0) return null;
  const nodeId = key.slice(0, hash) as TemporalNodeId;
  const kind = key.slice(hash + 1);
  if (kind !== "start" && kind !== "end") return null;
  return { nodeId, endpoint: kind };
}

export function explainNegativeCycle(
  graph: StnGraph,
  conflictId = "conflict:negative-cycle",
): TemporalConflict | null {
  if (!graph.negativeCycle || graph.negativeCycle.length === 0) return null;

  const cycle = graph.negativeCycle
    .map((edge) => edgeToCycleStep(graph, edge))
    .filter((step): step is NonNullable<typeof step> => step !== null);

  const constraintIds = [
    ...new Set(graph.negativeCycle.map((edge) => edge.constraintId)),
  ].sort((a, b) => a.localeCompare(b));
  const nodeIds = [
    ...new Set(cycle.flatMap((step) => [step.from.nodeId, step.to.nodeId])),
  ].sort((a, b) => a.localeCompare(b)) as TemporalNodeId[];

  return {
    conflictId,
    constraintIds,
    nodeIds,
    explanation: `Negative temporal cycle involving constraints: ${constraintIds.join(", ")}`,
    cycle,
  };
}

function edgeToCycleStep(
  graph: StnGraph,
  edge: StnEdge,
): {
  from: TemporalEndpointRef;
  to: TemporalEndpointRef;
  constraintId: string;
} | null {
  const fromKey = graph.variableKeys[edge.from];
  const toKey = graph.variableKeys[edge.to];
  if (!fromKey || !toKey) return null;
  const from = parseEndpoint(fromKey);
  const to = parseEndpoint(toKey);
  if (!from || !to) return null;
  return { from, to, constraintId: edge.constraintId };
}
