import type { NarrativeEntityId } from "./codexEntityHypothesis";
import type { InferenceId, ObservationId } from "../../temporal/nodes";

export type NarrativeConflictStatus =
  | "latent"
  | "active"
  | "escalated"
  | "resolved"
  | "transformed"
  | "unknown";

export interface NarrativeConflictInferencePayload {
  readonly conflictId: string;
  readonly sides: readonly {
    readonly entityIds: readonly NarrativeEntityId[];
    readonly objective: string;
  }[];
  readonly incompatibility: string;
  readonly stakes: string | null;
  readonly status: NarrativeConflictStatus;
}

export interface NarrativeConflictInference {
  readonly inferenceId: InferenceId;
  readonly kind: "narrative.conflict";
  readonly payload: NarrativeConflictInferencePayload;
  readonly sourceIds: readonly (ObservationId | InferenceId)[];
}
