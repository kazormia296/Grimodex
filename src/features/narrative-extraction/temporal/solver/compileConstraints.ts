import type {
  IntervalRelationConstraint,
  RelativeOffsetConstraint,
  TemporalConstraint,
  TemporalEndpointRef,
  TemporalOffsetUnit,
} from "../constraints";
import type { TemporalNode, TemporalNodeId } from "../nodes";
import {
  dayToEpochMinute,
  MINUTES_PER_DAY,
  type CalendarResolution,
} from "../resolution";

export type StnVarKind = "start" | "end";

export interface StnVariable {
  readonly key: string;
  readonly nodeId: TemporalNodeId;
  readonly kind: StnVarKind;
}

export interface CompiledDifferenceConstraint {
  readonly id: string;
  /** Encodes x - y <= c as edge y → x weight c */
  readonly fromKey: string; // y
  readonly toKey: string; // x
  readonly weight: number; // c
  readonly sourceConstraintId: string;
  readonly soft: boolean;
}

export interface CompiledAbsoluteBound {
  readonly variableKey: string;
  readonly earliest: number | null;
  readonly latest: number | null;
  readonly sourceConstraintId: string;
  readonly soft: boolean;
}

export interface CompiledDurationBound {
  readonly nodeId: TemporalNodeId;
  readonly minMinutes: number;
  readonly maxMinutes: number;
  readonly sourceConstraintId: string;
  readonly soft: boolean;
}

export interface CompileConstraintsResult {
  readonly variables: readonly StnVariable[];
  readonly differences: readonly CompiledDifferenceConstraint[];
  readonly absolutes: readonly CompiledAbsoluteBound[];
  readonly durations: readonly CompiledDurationBound[];
  readonly skippedConstraintIds: readonly string[];
  readonly diagnostics: readonly { code: string; message: string }[];
}

export function variableKey(nodeId: TemporalNodeId, kind: StnVarKind): string {
  return `${nodeId}#${kind}`;
}

export function endpointKey(ref: TemporalEndpointRef): string {
  if (ref.endpoint === "point") return variableKey(ref.nodeId, "start");
  return variableKey(ref.nodeId, ref.endpoint);
}

function unitToMinutes(
  amount: number,
  unit: TemporalOffsetUnit,
  weekLengthDays: number | null,
): number | null {
  switch (unit) {
    case "minute":
      return amount;
    case "hour":
      return amount * 60;
    case "day":
      return amount * MINUTES_PER_DAY;
    case "week":
      if (weekLengthDays === null || weekLengthDays <= 0) return null;
      return amount * weekLengthDays * MINUTES_PER_DAY;
    case "month":
    case "year":
      return null;
  }
}

function expandIntervalRelation(
  constraint: IntervalRelationConstraint,
): Array<{ left: TemporalEndpointRef; right: TemporalEndpointRef; weight: number }> {
  const A = constraint.leftNodeId;
  const B = constraint.rightNodeId;
  const start = (nodeId: TemporalNodeId): TemporalEndpointRef => ({
    nodeId,
    endpoint: "start",
  });
  const end = (nodeId: TemporalNodeId): TemporalEndpointRef => ({
    nodeId,
    endpoint: "end",
  });

  // Encode as left - right <= weight  (i.e. left <= right + weight)
  switch (constraint.relation) {
    case "before":
      // A.end < B.start  ⇒  A.end - B.start <= -1
      return [{ left: end(A), right: start(B), weight: -1 }];
    case "before-or-equal":
      // A.end <= B.start
      return [{ left: end(A), right: start(B), weight: 0 }];
    case "after":
      return [{ left: end(B), right: start(A), weight: -1 }];
    case "after-or-equal":
      return [{ left: end(B), right: start(A), weight: 0 }];
    case "meets":
      // A.end == B.start
      return [
        { left: end(A), right: start(B), weight: 0 },
        { left: start(B), right: end(A), weight: 0 },
      ];
    case "equals":
      return [
        { left: start(A), right: start(B), weight: 0 },
        { left: start(B), right: start(A), weight: 0 },
        { left: end(A), right: end(B), weight: 0 },
        { left: end(B), right: end(A), weight: 0 },
      ];
    case "starts":
      return [
        { left: start(A), right: start(B), weight: 0 },
        { left: start(B), right: start(A), weight: 0 },
        { left: end(A), right: end(B), weight: 0 },
      ];
    case "finishes":
      return [
        { left: end(A), right: end(B), weight: 0 },
        { left: end(B), right: end(A), weight: 0 },
        { left: start(B), right: start(A), weight: 0 },
      ];
    case "during":
      // B.start <= A.start && A.end <= B.end
      return [
        { left: start(B), right: start(A), weight: 0 },
        { left: end(A), right: end(B), weight: 0 },
      ];
    case "contains":
      return [
        { left: start(A), right: start(B), weight: 0 },
        { left: end(B), right: end(A), weight: 0 },
      ];
    case "overlaps":
      // A.start < B.start < A.end < B.end
      return [
        { left: start(A), right: start(B), weight: -1 },
        { left: start(B), right: end(A), weight: -1 },
        { left: end(A), right: end(B), weight: -1 },
      ];
  }
}

function resolutionBounds(
  resolved: CalendarResolution,
  endpoint: "start" | "end" | "point",
): { earliest: number; latest: number } {
  const startMin = dayToEpochMinute(
    resolved.startDay,
    resolved.startMinute ?? 0,
  );
  const endMin = dayToEpochMinute(
    resolved.endDay,
    resolved.endMinute ??
      (resolved.granularity === "time" ? (resolved.startMinute ?? 0) : MINUTES_PER_DAY - 1),
  );
  if (endpoint === "end") {
    if (resolved.precision === "exact" && resolved.granularity === "time") {
      return { earliest: endMin, latest: endMin };
    }
    if (resolved.precision === "exact" && resolved.startDay === resolved.endDay) {
      return {
        earliest: dayToEpochMinute(resolved.endDay, 0),
        latest: dayToEpochMinute(resolved.endDay, MINUTES_PER_DAY - 1),
      };
    }
    return { earliest: startMin, latest: endMin };
  }
  // start / point
  if (resolved.precision === "exact" && resolved.granularity === "time") {
    return { earliest: startMin, latest: startMin };
  }
  if (resolved.precision === "exact" && resolved.granularity === "day") {
    return {
      earliest: dayToEpochMinute(resolved.startDay, 0),
      latest: dayToEpochMinute(resolved.startDay, MINUTES_PER_DAY - 1),
    };
  }
  return { earliest: startMin, latest: endMin };
}

export interface CompileConstraintsOptions {
  readonly weekLengthDays: number | null;
  readonly includeSoft: boolean;
}

export function compileConstraints(
  nodes: readonly TemporalNode[],
  constraints: readonly TemporalConstraint[],
  options: CompileConstraintsOptions,
): CompileConstraintsResult {
  const sortedNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const sortedConstraints = [...constraints].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  const variables: StnVariable[] = [];
  for (const node of sortedNodes) {
    variables.push({
      key: variableKey(node.id, "start"),
      nodeId: node.id,
      kind: "start",
    });
    variables.push({
      key: variableKey(node.id, "end"),
      nodeId: node.id,
      kind: "end",
    });
  }

  const differences: CompiledDifferenceConstraint[] = [];
  const absolutes: CompiledAbsoluteBound[] = [];
  const durations: CompiledDurationBound[] = [];
  const skippedConstraintIds: string[] = [];
  const diagnostics: { code: string; message: string }[] = [];

  // Point / interval shape: start <= end; point also end <= start
  for (const node of sortedNodes) {
    differences.push({
      id: `shape:${node.id}:start-le-end`,
      fromKey: variableKey(node.id, "end"),
      toKey: variableKey(node.id, "start"),
      weight: 0,
      sourceConstraintId: `shape:${node.id}`,
      soft: false,
    });
    if (node.shape === "point") {
      differences.push({
        id: `shape:${node.id}:end-le-start`,
        fromKey: variableKey(node.id, "start"),
        toKey: variableKey(node.id, "end"),
        weight: 0,
        sourceConstraintId: `shape:${node.id}`,
        soft: false,
      });
    }
  }

  let diffSeq = 0;
  for (const constraint of sortedConstraints) {
    const soft = constraint.strictness === "soft";
    if (soft && !options.includeSoft) {
      skippedConstraintIds.push(constraint.id);
      continue;
    }

    switch (constraint.kind) {
      case "symbolic":
        skippedConstraintIds.push(constraint.id);
        continue;
      case "absolute-window": {
        if (!constraint.resolved) {
          skippedConstraintIds.push(constraint.id);
          diagnostics.push({
            code: "absolute-unresolved",
            message: `Absolute constraint ${constraint.id} has no CalendarResolution`,
          });
          continue;
        }
        const bounds = resolutionBounds(
          constraint.resolved,
          constraint.endpoint,
        );
        const kind =
          constraint.endpoint === "end"
            ? "end"
            : ("start" as const);
        absolutes.push({
          variableKey: variableKey(constraint.nodeId, kind),
          earliest: bounds.earliest,
          latest: bounds.latest,
          sourceConstraintId: constraint.id,
          soft,
        });
        if (constraint.endpoint === "point") {
          absolutes.push({
            variableKey: variableKey(constraint.nodeId, "end"),
            earliest: bounds.earliest,
            latest: bounds.latest,
            sourceConstraintId: constraint.id,
            soft,
          });
        }
        break;
      }
      case "relative-offset": {
        const compiled = compileRelativeOffset(
          constraint,
          options.weekLengthDays,
          soft,
          diffSeq,
        );
        diffSeq += compiled.differences.length;
        if (compiled.skipped) {
          skippedConstraintIds.push(constraint.id);
          diagnostics.push(...compiled.diagnostics);
        } else {
          differences.push(...compiled.differences);
        }
        break;
      }
      case "interval-relation": {
        for (const edge of expandIntervalRelation(constraint)) {
          // left - right <= weight  ⇒ edge right → left weight
          differences.push({
            id: `diff:${constraint.id}:${diffSeq++}`,
            fromKey: endpointKey(edge.right),
            toKey: endpointKey(edge.left),
            weight: edge.weight,
            sourceConstraintId: constraint.id,
            soft,
          });
        }
        break;
      }
      case "duration": {
        const min = unitToMinutes(
          constraint.duration.min,
          constraint.duration.unit,
          options.weekLengthDays,
        );
        const max = unitToMinutes(
          constraint.duration.max,
          constraint.duration.unit,
          options.weekLengthDays,
        );
        if (min === null || max === null) {
          skippedConstraintIds.push(constraint.id);
          diagnostics.push({
            code: "duration-calendar-unit",
            message: `Duration constraint ${constraint.id} uses calendar unit requiring calendar pass`,
          });
          continue;
        }
        durations.push({
          nodeId: constraint.nodeId,
          minMinutes: min,
          maxMinutes: max,
          sourceConstraintId: constraint.id,
          soft,
        });
        // end - start <= max; start - end <= -min
        differences.push({
          id: `diff:${constraint.id}:max`,
          fromKey: variableKey(constraint.nodeId, "start"),
          toKey: variableKey(constraint.nodeId, "end"),
          weight: max,
          sourceConstraintId: constraint.id,
          soft,
        });
        differences.push({
          id: `diff:${constraint.id}:min`,
          fromKey: variableKey(constraint.nodeId, "end"),
          toKey: variableKey(constraint.nodeId, "start"),
          weight: -min,
          sourceConstraintId: constraint.id,
          soft,
        });
        break;
      }
    }
  }

  return {
    variables,
    differences,
    absolutes,
    durations,
    skippedConstraintIds,
    diagnostics,
  };
}

function compileRelativeOffset(
  constraint: RelativeOffsetConstraint,
  weekLengthDays: number | null,
  soft: boolean,
  seqStart: number,
): {
  differences: CompiledDifferenceConstraint[];
  skipped: boolean;
  diagnostics: { code: string; message: string }[];
} {
  if (constraint.offset.arithmetic === "calendar") {
    return {
      differences: [],
      skipped: true,
      diagnostics: [
        {
          code: "relative-calendar-deferred",
          message: `Relative offset ${constraint.id} deferred to calendarConstraintPass`,
        },
      ],
    };
  }
  const min = unitToMinutes(
    constraint.offset.min,
    constraint.offset.unit,
    weekLengthDays,
  );
  const max = unitToMinutes(
    constraint.offset.max,
    constraint.offset.unit,
    weekLengthDays,
  );
  if (min === null || max === null) {
    return {
      differences: [],
      skipped: true,
      diagnostics: [
        {
          code: "week-length-undefined",
          message: `Week length is undefined; refusing to assume 7 days for ${constraint.id}`,
        },
      ],
    };
  }
  // left - right ∈ [min, max]  ⇒ left - right <= max and right - left <= -min
  let seq = seqStart;
  return {
    differences: [
      {
        id: `diff:${constraint.id}:${seq++}`,
        fromKey: endpointKey(constraint.right),
        toKey: endpointKey(constraint.left),
        weight: max,
        sourceConstraintId: constraint.id,
        soft,
      },
      {
        id: `diff:${constraint.id}:${seq++}`,
        fromKey: endpointKey(constraint.left),
        toKey: endpointKey(constraint.right),
        weight: -min,
        sourceConstraintId: constraint.id,
        soft,
      },
    ],
    skipped: false,
    diagnostics: [],
  };
}
