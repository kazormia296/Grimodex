import type { NarrativeEntityId } from "./codexEntityHypothesis";
import type {
  DocumentRef,
  InferenceId,
  ObservationId,
} from "../../temporal/nodes";

export type ForeshadowPayoffSignalKind =
  | "causal-unlock"
  | "character-reveal"
  | "object-return"
  | "motif-resolution"
  | "thematic-payoff"
  | "dialogue-echo"
  | "other";

export interface ForeshadowPayoffSignalPayload {
  readonly signalId: string;
  readonly documentRef: DocumentRef;
  readonly proposition: string;
  readonly signalKind: ForeshadowPayoffSignalKind;
  readonly relatedEntityIds: readonly NarrativeEntityId[];
  readonly readingOrderIndex: number;
  readonly materiality: "major" | "moderate" | "minor";
  readonly evidenceAnchorIds: readonly [string, ...string[]];
}

export interface ForeshadowPayoffSignalInference {
  readonly inferenceId: InferenceId;
  readonly kind: "foreshadow.payoff-signal";
  readonly payload: ForeshadowPayoffSignalPayload;
  readonly sourceIds: readonly (ObservationId | InferenceId)[];
}
