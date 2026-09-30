import type { NarrativeEntityId } from "./codexEntityHypothesis";
import type { TemporalNodeId } from "../../temporal/nodes";
import type { InferenceId, ObservationId } from "../../temporal/nodes";

export type NarrativeGoalStatus =
  | "proposed"
  | "active"
  | "achieved"
  | "failed"
  | "abandoned"
  | "replaced"
  | "unknown";

export interface NarrativeGoalInferencePayload {
  readonly goalId: string;
  readonly ownerEntityIds: readonly NarrativeEntityId[];
  readonly proposition: string;
  readonly status: NarrativeGoalStatus;
  readonly targetEntityIds: readonly NarrativeEntityId[];
  readonly obstacleEntityIds: readonly NarrativeEntityId[];
  readonly beginsAt: TemporalNodeId | null;
  readonly endsAt: TemporalNodeId | null;
}

export interface NarrativeGoalInference {
  readonly inferenceId: InferenceId;
  readonly kind: "narrative.goal";
  readonly payload: NarrativeGoalInferencePayload;
  readonly sourceIds: readonly (ObservationId | InferenceId)[];
}
