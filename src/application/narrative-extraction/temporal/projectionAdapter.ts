import type { Sha256Digest } from "@/features/narrative-extraction/source/types";
import type { TemporalConstraintAuthority } from "@/features/narrative-extraction/temporal/constraints";
import type { TemporalDiagnostic } from "@/features/narrative-extraction/temporal/graph";
import { isValidVersion } from "./adapterTypes";

export type TemporalProjectionTarget =
  | { readonly kind: "scene-time"; readonly sceneId: string }
  | { readonly kind: "event-time"; readonly eventId: string }
  | { readonly kind: "scene-story-order"; readonly sceneId: string };

export interface TemporalProjectionRecord {
  readonly id: string;
  readonly projectId: string;
  readonly target: TemporalProjectionTarget;
  readonly constraintSetDigest: Sha256Digest;
  readonly solverVersion: string;
  readonly calendarDigest: Sha256Digest | null;
  readonly projectedValueDigest: Sha256Digest;
  readonly targetResultVersion: number;
  readonly applicationId: string;
  readonly status: "current" | "invalidated" | "undone";
  readonly version: number;
}

export interface CurrentTemporalProjectionValue {
  readonly projectId: string;
  readonly target: TemporalProjectionTarget;
  readonly resultVersion: number;
  readonly valueDigest: Sha256Digest;
  readonly constraintSetDigest: Sha256Digest;
  readonly solverVersion: string;
  readonly calendarDigest: Sha256Digest | null;
}

export interface TemporalProjectionClassification {
  readonly folded: boolean;
  readonly authority: Extract<
    TemporalConstraintAuthority,
    "projection-derived" | "user-metadata"
  >;
  readonly diagnostic: TemporalDiagnostic | null;
}

function targetKey(target: TemporalProjectionTarget): string {
  switch (target.kind) {
    case "scene-time":
      return `scene-time:${target.sceneId}`;
    case "event-time":
      return `event-time:${target.eventId}`;
    case "scene-story-order":
      return `scene-story-order:${target.sceneId}`;
  }
}

function userMetadata(
  code: string,
  message: string,
): TemporalProjectionClassification {
  return {
    folded: false,
    authority: "user-metadata",
    diagnostic: { code, message },
  };
}

function staleProjection(
  code: string,
  message: string,
): TemporalProjectionClassification {
  return {
    folded: true,
    authority: "projection-derived",
    diagnostic: { code, message },
  };
}

/**
 * Determine whether a materialized Domain field is still exactly the output
 * of its source constraint set. This is deliberately read-only: callers may
 * surface the diagnostic or schedule invalidation, but the adapter never
 * mutates a future TemporalProjectionRecord store.
 */
export function classifyTemporalProjection(input: {
  readonly current: CurrentTemporalProjectionValue;
  readonly record: TemporalProjectionRecord | null;
}): TemporalProjectionClassification {
  const { current, record } = input;
  if (record === null) {
    return { folded: false, authority: "user-metadata", diagnostic: null };
  }
  if (record.projectId !== current.projectId) {
    return userMetadata(
      "TEMPORAL_ADAPTER_PROJECT_MISMATCH",
      `Temporal Projection ${JSON.stringify(record.id)} belongs to another Project`,
    );
  }
  if (targetKey(record.target) !== targetKey(current.target)) {
    return userMetadata(
      "TEMPORAL_PROJECTION_TARGET_CHANGED",
      `Temporal Projection ${JSON.stringify(record.id)} no longer targets this Domain field`,
    );
  }
  if (record.projectedValueDigest !== current.valueDigest) {
    return userMetadata(
      "TEMPORAL_PROJECTION_VALUE_CHANGED",
      `Temporal Projection ${JSON.stringify(record.id)} value was edited after projection`,
    );
  }
  if (
    !isValidVersion(record.version) ||
    !isValidVersion(record.targetResultVersion) ||
    !isValidVersion(current.resultVersion)
  ) {
    return staleProjection(
      "TEMPORAL_ADAPTER_INVALID_ROW",
      `Temporal Projection ${JSON.stringify(record.id)} has invalid version metadata`,
    );
  }
  if (record.status !== "current") {
    return staleProjection(
      "TEMPORAL_PROJECTION_NOT_CURRENT",
      `Temporal Projection ${JSON.stringify(record.id)} is ${JSON.stringify(record.status)}`,
    );
  }
  if (record.targetResultVersion !== current.resultVersion) {
    return staleProjection(
      "TEMPORAL_PROJECTION_VERSION_CHANGED",
      `Temporal Projection ${JSON.stringify(record.id)} target version changed`,
    );
  }
  if (
    record.constraintSetDigest !== current.constraintSetDigest ||
    record.solverVersion !== current.solverVersion ||
    record.calendarDigest !== current.calendarDigest
  ) {
    return staleProjection(
      "TEMPORAL_PROJECTION_SOURCE_CHANGED",
      `Temporal Projection ${JSON.stringify(record.id)} source constraints are stale`,
    );
  }
  return {
    folded: true,
    authority: "projection-derived",
    diagnostic: null,
  };
}

export function findTemporalProjectionRecord(
  records: readonly TemporalProjectionRecord[],
  target: TemporalProjectionTarget,
): TemporalProjectionRecord | null {
  const key = targetKey(target);
  return records.find((record) => targetKey(record.target) === key) ?? null;
}
