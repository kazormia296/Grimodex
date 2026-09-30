import type { ForeshadowSetupSignalKind } from "@/features/narrative-extraction/ir/inferences/foreshadowSetupSignal";
import type { ForeshadowPayoffSignalKind } from "@/features/narrative-extraction/ir/inferences/foreshadowPayoffSignal";
import type { SetupPayoffBridgeKind } from "@/features/narrative-extraction/ir/inferences/setupPayoffSupportEdge";

export interface ForeshadowInvariantInput {
  readonly setupKind?: ForeshadowSetupSignalKind;
  readonly payoffKind?: ForeshadowPayoffSignalKind;
  readonly bridgeKind?: SetupPayoffBridgeKind;
  readonly setupReadingOrder?: number;
  readonly payoffReadingOrder?: number;
  readonly setupProjectId?: string | null;
  readonly payoffProjectId?: string | null;
  readonly setupSceneId?: string | null;
  readonly payoffSceneId?: string | null;
}

export type ForeshadowInvariantDecision =
  | { readonly kind: "valid" }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Structural setup/payoff checks. Meaning flags such as decorative or
 * speculative are intentionally not inspected here.
 */
export function evaluateForeshadowInvariant(
  input: ForeshadowInvariantInput,
): ForeshadowInvariantDecision {
  if (
    input.setupProjectId != null &&
    input.payoffProjectId != null &&
    input.setupProjectId !== input.payoffProjectId
  ) {
    return { kind: "blocked", reason: "cross-project-setup-payoff" };
  }
  if (
    input.setupSceneId != null &&
    input.payoffSceneId != null &&
    input.setupSceneId === input.payoffSceneId
  ) {
    return { kind: "blocked", reason: "same-scene-setup-payoff" };
  }
  if (
    input.setupReadingOrder != null &&
    input.payoffReadingOrder != null &&
    input.payoffReadingOrder < input.setupReadingOrder
  ) {
    return { kind: "blocked", reason: "reading-order-setup-before-payoff" };
  }
  return { kind: "valid" };
}
