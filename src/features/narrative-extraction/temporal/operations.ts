/**
 * Commit-operation payload types for the Temporal Constraint Graph (TCG)
 * domain persistence (SCHEMA_VERSION 9). These mirror the Rust payload
 * structs 1:1 (camelCase wire format) so a compiler / commit-plan builder
 * can produce `DomainOperationBase<kind, payload>` values that
 * `narrative_extraction_apply_commit` accepts without transformation.
 *
 * Rust counterparts:
 * - `temporal_nodes.rs::TemporalNodeEnsurePayload`
 * - `temporal_constraints.rs::TemporalConstraintPayload`
 * - `temporal_operations.rs::TemporalChronicleMetadataPatchPayload` /
 *   `TemporalStoryOrderMaterializePayload`
 * - `temporal_projections.rs::TemporalProjectionRecordPayload`
 *
 * No compiler wires these into the extraction pipeline yet; that is left to
 * whichever proposal → operation compilation pass adopts the TCG proposals
 * (see `../proposals/createTemporalConstraintProposal.ts`,
 * `../proposals/setSceneTemporalMetadataProposal.ts`,
 * `../proposals/setEventTemporalMetadataProposal.ts`). The STN solver that
 * would populate `temporal.projection.record` is out of scope here too.
 */
import type {
  TemporalConstraintAuthority,
  TemporalIntervalRelation,
  TemporalOffsetUnit,
} from "./constraints";
import type { TemporalNodeId, TemporalNodeSubject } from "./nodes";

interface DomainOperationBase<TKind extends string, TPayload> {
  readonly kind: TKind;
  readonly payload: TPayload;
}

// ─── temporal.node.ensure ───────────────────────────────────────────────────

export const TEMPORAL_NODE_ENSURE_KIND = "temporal.node.ensure" as const;

export interface TemporalNodeEnsureOperationPayloadV1 {
  readonly nodeId: TemporalNodeId;
  readonly timelineKind?: "primary" | "alternate" | "embedded-fiction" | "hypothetical";
  readonly timelineKey?: string | null;
  readonly subject: TemporalNodeSubject;
  readonly shape?: "point" | "interval" | "unknown";
}

export type TemporalNodeEnsureOperationV1 = DomainOperationBase<
  typeof TEMPORAL_NODE_ENSURE_KIND,
  TemporalNodeEnsureOperationPayloadV1
>;

// ─── temporal.constraint.create ─────────────────────────────────────────────

export const TEMPORAL_CONSTRAINT_CREATE_KIND = "temporal.constraint.create" as const;

interface TemporalConstraintOperationCommon {
  readonly constraintId?: string;
  readonly authority: TemporalConstraintAuthority;
  readonly strictness: "hard" | "soft";
  readonly sourceIds?: readonly string[];
  readonly fingerprint?: string;
}

export interface TemporalAbsoluteWindowConstraintOperationPayloadV1
  extends TemporalConstraintOperationCommon {
  readonly kind: "absolute-window";
  readonly nodeId: TemporalNodeId;
  readonly endpoint: "start" | "end" | "point";
  readonly literal?: unknown;
  readonly resolved?: unknown;
}

export interface TemporalRelativeOffsetConstraintOperationPayloadV1
  extends TemporalConstraintOperationCommon {
  readonly kind: "relative-offset";
  readonly left: { readonly nodeId: TemporalNodeId; readonly endpoint: "start" | "end" | "point" };
  readonly right: { readonly nodeId: TemporalNodeId; readonly endpoint: "start" | "end" | "point" };
  readonly offset: {
    readonly min: number;
    readonly max: number;
    readonly unit: TemporalOffsetUnit;
    readonly arithmetic: "fixed" | "calendar";
  };
}

export interface TemporalIntervalRelationConstraintOperationPayloadV1
  extends TemporalConstraintOperationCommon {
  readonly kind: "interval-relation";
  readonly leftNodeId: TemporalNodeId;
  readonly relation: TemporalIntervalRelation;
  readonly rightNodeId: TemporalNodeId;
}

export interface TemporalDurationConstraintOperationPayloadV1
  extends TemporalConstraintOperationCommon {
  readonly kind: "duration";
  readonly nodeId: TemporalNodeId;
  readonly duration: { readonly min: number; readonly max: number; readonly unit: TemporalOffsetUnit };
}

export interface TemporalSymbolicConstraintOperationPayloadV1
  extends TemporalConstraintOperationCommon {
  readonly kind: "symbolic";
  readonly nodeId: TemporalNodeId;
  readonly relation:
    | "same-night"
    | "next-morning"
    | "soon-after"
    | "long-before"
    | "seasonal"
    | "other";
  readonly anchorNodeId?: TemporalNodeId | null;
  readonly label: string;
}

export type TemporalConstraintCreateOperationPayloadV1 =
  | TemporalAbsoluteWindowConstraintOperationPayloadV1
  | TemporalRelativeOffsetConstraintOperationPayloadV1
  | TemporalIntervalRelationConstraintOperationPayloadV1
  | TemporalDurationConstraintOperationPayloadV1
  | TemporalSymbolicConstraintOperationPayloadV1;

export type TemporalConstraintCreateOperationV1 = DomainOperationBase<
  typeof TEMPORAL_CONSTRAINT_CREATE_KIND,
  TemporalConstraintCreateOperationPayloadV1
>;

// ─── temporal.scene.metadata.patch / temporal.event.metadata.patch ─────────

export const TEMPORAL_SCENE_METADATA_PATCH_KIND = "temporal.scene.metadata.patch" as const;
export const TEMPORAL_EVENT_METADATA_PATCH_KIND = "temporal.event.metadata.patch" as const;

export type TemporalChronicleGranularity = "none" | "day" | "time";

interface TemporalChronicleMetadataPatchOperationPayloadCommon {
  readonly baseVersion: number;
  readonly startTime?: number | null;
  readonly startMinute?: number | null;
  readonly startGranularity?: TemporalChronicleGranularity;
  readonly endTime?: number | null;
  readonly endMinute?: number | null;
  readonly endGranularity?: TemporalChronicleGranularity;
  readonly precision?: "exact" | "approx" | "unknown";
}

export interface TemporalSceneMetadataPatchOperationPayloadV1
  extends TemporalChronicleMetadataPatchOperationPayloadCommon {
  readonly sceneId: string;
}

export type TemporalSceneMetadataPatchOperationV1 = DomainOperationBase<
  typeof TEMPORAL_SCENE_METADATA_PATCH_KIND,
  TemporalSceneMetadataPatchOperationPayloadV1
>;

export interface TemporalEventMetadataPatchOperationPayloadV1
  extends TemporalChronicleMetadataPatchOperationPayloadCommon {
  readonly eventId: string;
}

export type TemporalEventMetadataPatchOperationV1 = DomainOperationBase<
  typeof TEMPORAL_EVENT_METADATA_PATCH_KIND,
  TemporalEventMetadataPatchOperationPayloadV1
>;

// ─── temporal.story-order.materialize ───────────────────────────────────────

export const TEMPORAL_STORY_ORDER_MATERIALIZE_KIND =
  "temporal.story-order.materialize" as const;

export interface TemporalStoryOrderMaterializeOperationPayloadV1 {
  readonly sceneId: string;
  readonly baseVersion: number;
  readonly storyTimeOrder: string;
  readonly storyTimeLabel?: string | null;
}

export type TemporalStoryOrderMaterializeOperationV1 = DomainOperationBase<
  typeof TEMPORAL_STORY_ORDER_MATERIALIZE_KIND,
  TemporalStoryOrderMaterializeOperationPayloadV1
>;

// ─── temporal.projection.record ─────────────────────────────────────────────

export const TEMPORAL_PROJECTION_RECORD_KIND = "temporal.projection.record" as const;

export type TemporalProjectionTargetKind =
  | "scene-time"
  | "event-time"
  | "scene-story-order";

export type TemporalProjectionOcc =
  | { readonly kind: "absent" }
  | { readonly kind: "version"; readonly version: number };

export interface TemporalProjectionRecordOperationPayloadV1 {
  readonly projectionId?: string;
  readonly targetKind: TemporalProjectionTargetKind;
  readonly targetId: string;
  readonly constraintSetDigest: string;
  readonly solverVersion: string;
  readonly calendarDigest?: string | null;
  readonly projectedValueDigest: string;
  readonly targetResultVersion: number;
  readonly applicationId: string;
  readonly status?: "current" | "invalidated" | "undone";
  readonly occ: TemporalProjectionOcc;
}

export type TemporalProjectionRecordOperationV1 = DomainOperationBase<
  typeof TEMPORAL_PROJECTION_RECORD_KIND,
  TemporalProjectionRecordOperationPayloadV1
>;

// ─── Union of all TCG commit operations ─────────────────────────────────────

export type TemporalCommitOperationV1 =
  | TemporalNodeEnsureOperationV1
  | TemporalConstraintCreateOperationV1
  | TemporalSceneMetadataPatchOperationV1
  | TemporalEventMetadataPatchOperationV1
  | TemporalStoryOrderMaterializeOperationV1
  | TemporalProjectionRecordOperationV1;
