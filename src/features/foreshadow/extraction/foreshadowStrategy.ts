import type { ForeshadowSetupSignalKind } from "@/features/narrative-extraction/ir/inferences/foreshadowSetupSignal";
import type { ForeshadowPayoffSignalKind } from "@/features/narrative-extraction/ir/inferences/foreshadowPayoffSignal";
import type { SetupPayoffBridgeKind } from "@/features/narrative-extraction/ir/inferences/setupPayoffSupportEdge";

export interface ForeshadowStrategyInput {
  readonly setupKind?: ForeshadowSetupSignalKind;
  readonly payoffKind?: ForeshadowPayoffSignalKind;
  readonly bridgeKind?: SetupPayoffBridgeKind;
  readonly materiality: "major" | "moderate" | "minor";
  readonly isMereRepetition?: boolean;
  readonly isCallbackOnly?: boolean;
  readonly isDecorative?: boolean;
  readonly isSpeculative?: boolean;
  readonly isRetrospective?: boolean;
  readonly isGenericCausality?: boolean;
}

export type ForeshadowStrategyDecision =
  | { readonly kind: "admit" }
  | { readonly kind: "reject"; readonly reason: string };

/**
 * Narrative strategy checks for false-positive suppression. This module is
 * planner-facing and must not be imported by a Domain compiler or Writer.
 */
export function evaluateForeshadowStrategy(
  input: ForeshadowStrategyInput,
): ForeshadowStrategyDecision {
  if (input.isMereRepetition) {
    return { kind: "reject", reason: "mere-repetition" };
  }
  if (input.isCallbackOnly) {
    return { kind: "reject", reason: "callback-only" };
  }
  if (input.isSpeculative) {
    return { kind: "reject", reason: "speculative" };
  }
  if (input.isDecorative) {
    return { kind: "reject", reason: "decorative" };
  }
  if (input.isRetrospective) {
    return { kind: "reject", reason: "retrospective" };
  }
  if (input.isGenericCausality && input.setupKind !== "causal-seed") {
    return { kind: "reject", reason: "generic-causality" };
  }
  if (input.materiality === "minor" && input.isDecorative !== false) {
    if (
      input.setupKind === "atmospheric-motif" ||
      input.bridgeKind === "motif-resolution"
    ) {
      return { kind: "reject", reason: "minor-decorative-motif" };
    }
  }
  return { kind: "admit" };
}
