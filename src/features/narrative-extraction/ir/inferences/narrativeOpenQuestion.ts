import type { NarrativeEntityId } from "./codexEntityHypothesis";
import type { InferenceId, ObservationId } from "../../temporal/nodes";

export type NarrativeOpenQuestionStatus =
  | "opened"
  | "partially-answered"
  | "answered"
  | "false-premise"
  | "abandoned"
  | "unknown";

export interface NarrativeOpenQuestionInferencePayload {
  readonly questionId: string;
  readonly proposition: string;
  readonly status: NarrativeOpenQuestionStatus;
  readonly relatedEntityIds: readonly NarrativeEntityId[];
  readonly openedByIds: readonly (ObservationId | InferenceId)[];
  readonly answerIds: readonly (ObservationId | InferenceId)[];
}

export interface NarrativeOpenQuestionInference {
  readonly inferenceId: InferenceId;
  readonly kind: "narrative.open-question";
  readonly payload: NarrativeOpenQuestionInferencePayload;
}
