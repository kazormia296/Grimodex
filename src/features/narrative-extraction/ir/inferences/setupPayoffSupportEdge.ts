import type { InferenceId, ObservationId } from "../../temporal/nodes";

/** Bridge semantics linking one setup signal to one payoff signal. */
export type SetupPayoffBridgeKind =
  | "direct-echo"
  | "causal-unlock"
  | "character-reveal"
  | "object-return"
  | "motif-resolution"
  | "thematic-payoff"
  | "other";

export interface SetupPayoffSupportEdgePayload {
  readonly edgeId: string;
  readonly setupSignalId: string;
  readonly payoffSignalId: string;
  readonly bridgeKind: SetupPayoffBridgeKind;
  readonly confidence: "high" | "medium" | "low";
  readonly explanation: string;
  readonly evidenceAnchorIds: readonly [string, ...string[]];
}

export interface SetupPayoffSupportEdgeInference {
  readonly inferenceId: InferenceId;
  readonly kind: "foreshadow.setup-payoff-edge";
  readonly payload: SetupPayoffSupportEdgePayload;
  readonly sourceIds: readonly (ObservationId | InferenceId)[];
}
