import type { NarrativeEntityId } from "./codexEntityHypothesis";
import type {
  DocumentRef,
  InferenceId,
  ObservationId,
} from "../../temporal/nodes";

export type ForeshadowSetupSignalKind =
  | "causal-seed"
  | "prophetic-hint"
  | "object-plant"
  | "character-trait"
  | "atmospheric-motif"
  | "dialogue-echo"
  | "other";

export interface ForeshadowSetupSignalPayload {
  readonly signalId: string;
  readonly documentRef: DocumentRef;
  readonly proposition: string;
  readonly signalKind: ForeshadowSetupSignalKind;
  readonly relatedEntityIds: readonly NarrativeEntityId[];
  readonly readingOrderIndex: number;
  readonly materiality: "major" | "moderate" | "minor";
  readonly evidenceAnchorIds: readonly [string, ...string[]];
}

export interface ForeshadowSetupSignalInference {
  readonly inferenceId: InferenceId;
  readonly kind: "foreshadow.setup-signal";
  readonly payload: ForeshadowSetupSignalPayload;
  readonly sourceIds: readonly (ObservationId | InferenceId)[];
}
