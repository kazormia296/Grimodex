import { hasLoneSurrogate } from "../source/digest";
import {
  isSemanticFingerprint,
  isTemporalNodeId,
  type InferenceId,
  type ObservationId,
  type SemanticFingerprint,
  type TemporalNode,
  type TemporalNodeId,
} from "./nodes";
import type {
  CalendarResolution,
  TemporalGranularity,
  TemporalPrecision,
} from "./resolution";

export interface AbsoluteTemporalLiteral {
  readonly kind: "absolute";
  readonly calendarRef: string | null;
  readonly eraRef?: string | null;
  readonly year?: number;
  readonly seasonRef?: string;
  readonly monthRef?: string;
  readonly day?: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly granularity: TemporalGranularity;
  readonly precision: TemporalPrecision;
}

export type TemporalOffsetUnit =
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "year";

export interface RelativeTemporalLiteral {
  readonly kind: "relative";
  readonly direction: "before" | "after" | "same-time" | "during";
  readonly amount: {
    readonly min: number;
    readonly max: number;
    readonly unit: TemporalOffsetUnit;
  } | null;
  readonly anchorSurface: string | null;
  readonly qualifier:
    | "exact"
    | "at-least"
    | "at-most"
    | "approximately"
    | "vague";
}

export interface DurationTemporalLiteral {
  readonly kind: "duration";
  readonly min: number | null;
  readonly max: number | null;
  readonly unit: TemporalOffsetUnit;
  readonly qualifier: "exact" | "approximately" | "at-least" | "at-most";
}

export interface QualitativeTemporalLiteral {
  readonly kind: "qualitative";
  readonly category:
    | "morning"
    | "noon"
    | "evening"
    | "night"
    | "dawn"
    | "dusk"
    | "soon"
    | "long-ago"
    | "recently"
    | "seasonal"
    | "other";
  readonly label: string;
}

export type TemporalLiteral =
  | AbsoluteTemporalLiteral
  | RelativeTemporalLiteral
  | DurationTemporalLiteral
  | QualitativeTemporalLiteral;

export interface TemporalEndpointRef {
  readonly nodeId: TemporalNodeId;
  readonly endpoint: "start" | "end" | "point";
}

export type TemporalConstraintAuthority =
  | "user-metadata"
  | "user-confirmed"
  | "explicit-story-text"
  | "existing-domain-relation"
  | "deterministic-derived"
  | "model-inferred"
  | "projection-derived";

interface TemporalConstraintBase<K extends string> {
  readonly id: string;
  readonly kind: K;
  readonly authority: TemporalConstraintAuthority;
  readonly strictness: "hard" | "soft";
  readonly sourceIds: readonly (ObservationId | InferenceId)[];
  readonly fingerprint: SemanticFingerprint;
}

export interface AbsoluteWindowConstraint extends TemporalConstraintBase<"absolute-window"> {
  readonly nodeId: TemporalNodeId;
  readonly endpoint: "start" | "end" | "point";
  /** Existing canonical Domain metadata has no recoverable source literal. */
  readonly literal: AbsoluteTemporalLiteral | null;
  readonly resolved: CalendarResolution | null;
}

export interface RelativeOffsetConstraint extends TemporalConstraintBase<"relative-offset"> {
  readonly left: TemporalEndpointRef;
  readonly right: TemporalEndpointRef;
  /** left - right range. */
  readonly offset: {
    readonly min: number;
    readonly max: number;
    readonly unit: TemporalOffsetUnit;
    readonly arithmetic: "fixed" | "calendar";
  };
}

export type TemporalIntervalRelation =
  | "before"
  | "before-or-equal"
  | "after"
  | "after-or-equal"
  | "meets"
  | "overlaps"
  | "during"
  | "contains"
  | "starts"
  | "finishes"
  | "equals";

export interface IntervalRelationConstraint extends TemporalConstraintBase<"interval-relation"> {
  readonly leftNodeId: TemporalNodeId;
  readonly relation: TemporalIntervalRelation;
  readonly rightNodeId: TemporalNodeId;
}

export interface DurationConstraint extends TemporalConstraintBase<"duration"> {
  readonly nodeId: TemporalNodeId;
  readonly duration: {
    readonly min: number;
    readonly max: number;
    readonly unit: TemporalOffsetUnit;
  };
}

export interface SymbolicTemporalConstraint extends TemporalConstraintBase<"symbolic"> {
  readonly nodeId: TemporalNodeId;
  readonly relation:
    | "same-night"
    | "next-morning"
    | "soon-after"
    | "long-before"
    | "seasonal"
    | "other";
  readonly anchorNodeId: TemporalNodeId | null;
  readonly label: string;
}

export type TemporalConstraint =
  | AbsoluteWindowConstraint
  | RelativeOffsetConstraint
  | IntervalRelationConstraint
  | DurationConstraint
  | SymbolicTemporalConstraint;

export interface TemporalConstraintDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

function diagnostic(
  code: string,
  message: string,
  path?: string,
): TemporalConstraintDiagnostic {
  return { code, message, ...(path ? { path } : {}) };
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !hasLoneSurrogate(value) &&
    !/\p{Cc}/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TEMPORAL_AUTHORITIES = new Set<TemporalConstraintAuthority>([
  "user-metadata",
  "user-confirmed",
  "explicit-story-text",
  "existing-domain-relation",
  "deterministic-derived",
  "model-inferred",
  "projection-derived",
]);

const TEMPORAL_UNITS = new Set<TemporalOffsetUnit>([
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "year",
]);

const TEMPORAL_ENDPOINTS = new Set<TemporalEndpointRef["endpoint"]>([
  "start",
  "end",
  "point",
]);

const TEMPORAL_GRANULARITIES = new Set<TemporalGranularity>([
  "season",
  "year",
  "month",
  "day",
  "time",
]);

const TEMPORAL_PRECISIONS = new Set<TemporalPrecision>([
  "exact",
  "approx",
  "unknown",
]);

const INTERVAL_RELATIONS = new Set<TemporalIntervalRelation>([
  "before",
  "before-or-equal",
  "after",
  "after-or-equal",
  "meets",
  "overlaps",
  "during",
  "contains",
  "starts",
  "finishes",
  "equals",
]);

const SYMBOLIC_RELATIONS = new Set<SymbolicTemporalConstraint["relation"]>([
  "same-night",
  "next-morning",
  "soon-after",
  "long-before",
  "seasonal",
  "other",
]);

function validIntegerRange(min: unknown, max: unknown): boolean {
  return (
    Number.isSafeInteger(min) &&
    Number.isSafeInteger(max) &&
    (min as number) <= (max as number)
  );
}

function validateEndpoint(
  endpoint: TemporalEndpointRef,
  nodesById: ReadonlyMap<TemporalNodeId, TemporalNode>,
  path: string,
): TemporalConstraintDiagnostic[] {
  const diagnostics: TemporalConstraintDiagnostic[] = [];
  const endpointIsValid = TEMPORAL_ENDPOINTS.has(endpoint?.endpoint);
  if (!endpointIsValid) {
    diagnostics.push(
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_ENDPOINT",
        "Temporal endpoint must be start, end, or point",
        `${path}.endpoint`,
      ),
    );
  }
  if (!isTemporalNodeId(endpoint?.nodeId)) {
    diagnostics.push(
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_NODE_ID",
        "Temporal endpoint has an invalid node id",
        `${path}.nodeId`,
      ),
    );
    return diagnostics;
  }
  const node = nodesById.get(endpoint.nodeId);
  if (!node) {
    diagnostics.push(
      diagnostic(
        "TEMPORAL_CONSTRAINT_UNKNOWN_NODE",
        `Temporal endpoint references an unknown node: ${endpoint.nodeId}`,
        `${path}.nodeId`,
      ),
    );
    return diagnostics;
  }
  const validForShape =
    endpointIsValid &&
    (node.shape === "unknown" ||
      (node.shape === "point" && endpoint.endpoint === "point") ||
      (node.shape === "interval" &&
        (endpoint.endpoint === "start" || endpoint.endpoint === "end")));
  if (endpointIsValid && !validForShape) {
    diagnostics.push(
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_ENDPOINT",
        `Endpoint ${endpoint.endpoint} is incompatible with ${node.shape} node ${node.id}`,
        `${path}.endpoint`,
      ),
    );
  }
  return diagnostics;
}

function validateNodeReference(
  nodeId: TemporalNodeId,
  nodesById: ReadonlyMap<TemporalNodeId, TemporalNode>,
  path: string,
): TemporalConstraintDiagnostic[] {
  if (!isTemporalNodeId(nodeId)) {
    return [
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_NODE_ID",
        "Temporal constraint has an invalid node id",
        path,
      ),
    ];
  }
  return nodesById.has(nodeId)
    ? []
    : [
        diagnostic(
          "TEMPORAL_CONSTRAINT_UNKNOWN_NODE",
          `Temporal constraint references an unknown node: ${nodeId}`,
          path,
        ),
      ];
}

function validateResolution(
  resolution: CalendarResolution,
  path: string,
): TemporalConstraintDiagnostic[] {
  if (!isRecord(resolution)) {
    return [
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_CALENDAR_RESOLUTION",
        "Calendar resolution must be an object",
        path,
      ),
    ];
  }
  const diagnostics: TemporalConstraintDiagnostic[] = [];
  if (
    !validIdentity(resolution.calendarRef) ||
    !isSemanticFingerprint(resolution.calendarDigest)
  ) {
    diagnostics.push(
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_CALENDAR_RESOLUTION",
        "Calendar resolution identity is invalid",
        path,
      ),
    );
  }
  if (!validIntegerRange(resolution.startDay, resolution.endDay)) {
    diagnostics.push(
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_RANGE",
        "Calendar resolution has an invalid day range",
        path,
      ),
    );
  }
  if (
    !TEMPORAL_GRANULARITIES.has(resolution.granularity) ||
    !TEMPORAL_PRECISIONS.has(resolution.precision)
  ) {
    diagnostics.push(
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_CALENDAR_RESOLUTION",
        "Calendar resolution granularity or precision is invalid",
        path,
      ),
    );
  }
  for (const [key, minute] of [
    ["startMinute", resolution.startMinute],
    ["endMinute", resolution.endMinute],
  ] as const) {
    if (
      minute !== null &&
      (!Number.isSafeInteger(minute) || minute < 0 || minute > 1_439)
    ) {
      diagnostics.push(
        diagnostic(
          "TEMPORAL_CONSTRAINT_INVALID_MINUTE",
          "Calendar resolution minute must be within 0..1439",
          `${path}.${key}`,
        ),
      );
    }
  }
  if (
    resolution.startDay === resolution.endDay &&
    typeof resolution.startMinute === "number" &&
    typeof resolution.endMinute === "number" &&
    Number.isSafeInteger(resolution.startMinute) &&
    Number.isSafeInteger(resolution.endMinute) &&
    resolution.startMinute > resolution.endMinute
  ) {
    diagnostics.push(
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_RANGE",
        "Calendar resolution has a reversed minute range on the same day",
        path,
      ),
    );
  }
  return diagnostics;
}

function validateAbsoluteLiteral(
  literal: AbsoluteTemporalLiteral,
): TemporalConstraintDiagnostic[] {
  const value = literal as unknown;
  if (!isRecord(value) || value.kind !== "absolute") {
    return [
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_LITERAL",
        "Absolute temporal literal is invalid",
        "literal",
      ),
    ];
  }
  const optionalIdentityKeys = ["eraRef", "seasonRef", "monthRef"] as const;
  const invalidIdentity =
    (value.calendarRef !== null && !validIdentity(value.calendarRef)) ||
    optionalIdentityKeys.some(
      (key) =>
        value[key] !== undefined &&
        value[key] !== null &&
        !validIdentity(value[key]),
    );
  const invalidNumber =
    (value.year !== undefined && !Number.isSafeInteger(value.year)) ||
    (value.day !== undefined &&
      (!Number.isSafeInteger(value.day) || (value.day as number) < 1)) ||
    (value.hour !== undefined &&
      (!Number.isSafeInteger(value.hour) ||
        (value.hour as number) < 0 ||
        (value.hour as number) > 23)) ||
    (value.minute !== undefined &&
      (!Number.isSafeInteger(value.minute) ||
        (value.minute as number) < 0 ||
        (value.minute as number) > 59));
  if (
    invalidIdentity ||
    invalidNumber ||
    !TEMPORAL_GRANULARITIES.has(value.granularity as TemporalGranularity) ||
    !TEMPORAL_PRECISIONS.has(value.precision as TemporalPrecision)
  ) {
    return [
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_LITERAL",
        "Absolute temporal literal is invalid",
        "literal",
      ),
    ];
  }
  return [];
}

export function validateTemporalConstraint(
  constraint: TemporalConstraint,
  nodes: readonly TemporalNode[],
): TemporalConstraintDiagnostic[] {
  const diagnostics: TemporalConstraintDiagnostic[] = [];
  const nodesById = new Map<TemporalNodeId, TemporalNode>();
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (isRecord(node) && isTemporalNodeId(node.id)) {
        nodesById.set(node.id, node as unknown as TemporalNode);
      }
    }
  }
  if (!validIdentity(constraint?.id)) {
    diagnostics.push(
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_ID",
        "Temporal constraint id is invalid",
        "id",
      ),
    );
  }
  if (constraint?.strictness !== "hard" && constraint?.strictness !== "soft") {
    diagnostics.push(
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_STRICTNESS",
        "Temporal constraint strictness must be hard or soft",
        "strictness",
      ),
    );
  }
  if (!isSemanticFingerprint(constraint?.fingerprint)) {
    diagnostics.push(
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_FINGERPRINT",
        "Temporal constraint fingerprint is not a SHA-256 digest",
        "fingerprint",
      ),
    );
  }
  if (!TEMPORAL_AUTHORITIES.has(constraint?.authority)) {
    diagnostics.push(
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_AUTHORITY",
        "Temporal constraint authority is invalid",
        "authority",
      ),
    );
  }
  if (
    !Array.isArray(constraint?.sourceIds) ||
    constraint.sourceIds.some((sourceId) => !validIdentity(sourceId))
  ) {
    diagnostics.push(
      diagnostic(
        "TEMPORAL_CONSTRAINT_INVALID_SOURCE_IDS",
        "Temporal constraint source ids are invalid",
        "sourceIds",
      ),
    );
  }

  switch (constraint?.kind) {
    case "absolute-window": {
      diagnostics.push(
        ...validateEndpoint(
          { nodeId: constraint.nodeId, endpoint: constraint.endpoint },
          nodesById,
          "node",
        ),
      );
      if (constraint.literal === null && constraint.resolved === null) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_CONSTRAINT_EMPTY_ABSOLUTE",
            "Absolute window needs a literal or canonical resolution",
          ),
        );
      }
      if (constraint.literal !== null) {
        diagnostics.push(...validateAbsoluteLiteral(constraint.literal));
      }
      if (constraint.resolved !== null) {
        diagnostics.push(
          ...validateResolution(constraint.resolved, "resolved"),
        );
      }
      break;
    }
    case "relative-offset":
      diagnostics.push(
        ...validateEndpoint(constraint.left, nodesById, "left"),
        ...validateEndpoint(constraint.right, nodesById, "right"),
      );
      if (!validIntegerRange(constraint.offset?.min, constraint.offset?.max)) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_CONSTRAINT_INVALID_RANGE",
            "Relative offset has an invalid range",
            "offset",
          ),
        );
      }
      if (!TEMPORAL_UNITS.has(constraint.offset?.unit)) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_CONSTRAINT_INVALID_UNIT",
            "Relative offset unit is invalid",
            "offset.unit",
          ),
        );
      }
      if (
        constraint.offset?.arithmetic !== "fixed" &&
        constraint.offset?.arithmetic !== "calendar"
      ) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_CONSTRAINT_INVALID_ARITHMETIC",
            "Relative offset arithmetic is invalid",
            "offset.arithmetic",
          ),
        );
      }
      break;
    case "interval-relation":
      diagnostics.push(
        ...validateNodeReference(
          constraint.leftNodeId,
          nodesById,
          "leftNodeId",
        ),
        ...validateNodeReference(
          constraint.rightNodeId,
          nodesById,
          "rightNodeId",
        ),
      );
      if (!INTERVAL_RELATIONS.has(constraint.relation)) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_CONSTRAINT_INVALID_RELATION",
            "Interval relation is invalid",
            "relation",
          ),
        );
      }
      break;
    case "duration":
      if (!nodesById.has(constraint.nodeId)) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_CONSTRAINT_UNKNOWN_NODE",
            `Duration references an unknown node: ${constraint.nodeId}`,
            "nodeId",
          ),
        );
      }
      if (
        !validIntegerRange(
          constraint.duration?.min,
          constraint.duration?.max,
        ) ||
        (constraint.duration?.min ?? -1) < 0
      ) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_CONSTRAINT_INVALID_RANGE",
            "Duration has an invalid range",
            "duration",
          ),
        );
      }
      if (!TEMPORAL_UNITS.has(constraint.duration?.unit)) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_CONSTRAINT_INVALID_UNIT",
            "Duration unit is invalid",
            "duration.unit",
          ),
        );
      }
      break;
    case "symbolic":
      if (!nodesById.has(constraint.nodeId)) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_CONSTRAINT_UNKNOWN_NODE",
            `Symbolic constraint references an unknown node: ${constraint.nodeId}`,
            "nodeId",
          ),
        );
      }
      if (
        constraint.anchorNodeId !== null &&
        !nodesById.has(constraint.anchorNodeId)
      ) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_CONSTRAINT_UNKNOWN_NODE",
            `Symbolic constraint references an unknown anchor: ${constraint.anchorNodeId}`,
            "anchorNodeId",
          ),
        );
      }
      if (!SYMBOLIC_RELATIONS.has(constraint.relation)) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_CONSTRAINT_INVALID_RELATION",
            "Symbolic relation is invalid",
            "relation",
          ),
        );
      }
      if (!validIdentity(constraint.label)) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_CONSTRAINT_INVALID_LABEL",
            "Symbolic constraint label is invalid",
            "label",
          ),
        );
      }
      break;
    default:
      diagnostics.push(
        diagnostic(
          "TEMPORAL_CONSTRAINT_UNKNOWN_KIND",
          "Temporal constraint kind is unknown",
          "kind",
        ),
      );
  }
  return diagnostics;
}
