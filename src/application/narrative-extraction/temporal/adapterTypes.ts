import type { TemporalConstraint } from "@/features/narrative-extraction/temporal/constraints";
import {
  isSemanticFingerprint,
  type TemporalNode,
} from "@/features/narrative-extraction/temporal/nodes";
import type { TemporalDiagnostic } from "@/features/narrative-extraction/temporal/graph";
import { hasLoneSurrogate } from "@/features/narrative-extraction/source/digest";
import { freezeDeep } from "@/features/narrative-extraction/source/immutability";

export interface VersionedDomainFreshness {
  readonly kind: "scene" | "event" | "scene-story-order";
  readonly id: string;
  readonly version: number;
  readonly updatedAt: string;
}

export interface EventRelationFreshness {
  readonly kind: "event-relation";
  readonly id: string;
  readonly endpointVersions: readonly [
    {
      readonly eventId: string;
      readonly version: number;
      readonly updatedAt: string;
    },
    {
      readonly eventId: string;
      readonly version: number;
      readonly updatedAt: string;
    },
  ];
}

export type TemporalDomainFreshness =
  | VersionedDomainFreshness
  | EventRelationFreshness;

export interface TemporalDomainAdapterResult<
  Constraint extends TemporalConstraint = TemporalConstraint,
> {
  readonly nodes: readonly TemporalNode[];
  readonly constraints: readonly Constraint[];
  readonly freshness: readonly TemporalDomainFreshness[];
  readonly diagnostics: readonly TemporalDiagnostic[];
}

export interface AdapterCalendarIdentity {
  readonly calendarRef: string;
  readonly calendarDigest: `sha256:${string}`;
}

export function isValidAdapterCalendarIdentity(
  value: AdapterCalendarIdentity | null,
): value is AdapterCalendarIdentity {
  return (
    value !== null &&
    isNonEmpty(value.calendarRef) &&
    isSemanticFingerprint(value.calendarDigest)
  );
}

export function isValidVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isNonEmpty(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !hasLoneSurrogate(value) &&
    !/\p{Cc}/u.test(value)
  );
}

export function snapshotAdapterInput<T>(input: T): T | null {
  try {
    return structuredClone(input);
  } catch {
    return null;
  }
}

export function invalidAdapterInputDiagnostic(): TemporalDiagnostic {
  return {
    code: "TEMPORAL_ADAPTER_INVALID_INPUT",
    message: "Temporal Domain adapter input cannot be copied",
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sealAdapterResult<Constraint extends TemporalConstraint>(
  result: TemporalDomainAdapterResult<Constraint>,
): TemporalDomainAdapterResult<Constraint> {
  return freezeDeep({
    nodes: [...result.nodes].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
    constraints: [...result.constraints].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
    freshness: [...result.freshness].sort(
      (left, right) =>
        compareStrings(left.kind, right.kind) ||
        compareStrings(left.id, right.id),
    ),
    diagnostics: [...result.diagnostics].sort(
      (left, right) =>
        compareStrings(left.code, right.code) ||
        compareStrings(left.path ?? "", right.path ?? "") ||
        compareStrings(left.message, right.message),
    ),
  });
}

export function projectMismatchDiagnostic(
  kind: string,
  id: string,
): TemporalDiagnostic {
  return {
    code: "TEMPORAL_ADAPTER_PROJECT_MISMATCH",
    message: `${kind} ${JSON.stringify(id)} does not belong to the requested Project`,
  };
}

export function invalidRowDiagnostic(
  kind: string,
  id: string,
  reason: string,
): TemporalDiagnostic {
  return {
    code: "TEMPORAL_ADAPTER_INVALID_ROW",
    message: `${kind} ${JSON.stringify(id)} is invalid: ${JSON.stringify(reason)}`,
  };
}

export function sceneNodeId(sceneId: string): `tn:${string}` {
  return `tn:scene:${encodeURIComponent(sceneId)}`;
}

export function eventNodeId(eventId: string): `tn:${string}` {
  return `tn:event:${encodeURIComponent(eventId)}`;
}
