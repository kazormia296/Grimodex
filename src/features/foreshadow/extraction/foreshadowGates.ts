import type { ForeshadowSetupSignalKind } from "@/features/narrative-extraction/ir/inferences/foreshadowSetupSignal";
import type { ForeshadowPayoffSignalKind } from "@/features/narrative-extraction/ir/inferences/foreshadowPayoffSignal";
import type { SetupPayoffBridgeKind } from "@/features/narrative-extraction/ir/inferences/setupPayoffSupportEdge";

export interface ForeshadowGateInput {
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
  readonly setupReadingOrder?: number;
  readonly payoffReadingOrder?: number;
}

export type ForeshadowGateDecision =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: string };

/**
 * Deterministic false-positive gates for setup/payoff signal admission.
 * Mirrors plot-threads/extraction discipline: reject background-only /
 * decorative / reading-order violations before proposals are planned.
 */
export function evaluateForeshadowGate(
  input: ForeshadowGateInput,
): ForeshadowGateDecision {
  if (input.isMereRepetition) {
    return { admit: false, reason: "mere-repetition" };
  }
  if (input.isCallbackOnly) {
    return { admit: false, reason: "callback-only" };
  }
  if (input.isSpeculative) {
    return { admit: false, reason: "speculative" };
  }
  if (input.isDecorative) {
    return { admit: false, reason: "decorative" };
  }
  if (input.isRetrospective) {
    return { admit: false, reason: "retrospective" };
  }
  if (input.isGenericCausality && input.setupKind !== "causal-seed") {
    return { admit: false, reason: "generic-causality" };
  }
  if (
    input.setupReadingOrder != null &&
    input.payoffReadingOrder != null &&
    input.payoffReadingOrder < input.setupReadingOrder
  ) {
    return { admit: false, reason: "reading-order-setup-before-payoff" };
  }
  if (input.materiality === "minor" && input.isDecorative !== false) {
    if (
      input.setupKind === "atmospheric-motif" ||
      input.bridgeKind === "motif-resolution"
    ) {
      return { admit: false, reason: "minor-decorative-motif" };
    }
  }
  return { admit: true };
}

/** Setup signal must carry narrative materiality beyond mere co-presence. */
export function isMaterialSetupSignal(input: {
  readonly materiality: "major" | "moderate" | "minor";
  readonly signalKind: ForeshadowSetupSignalKind;
}): boolean {
  if (input.materiality === "major" || input.materiality === "moderate") {
    return true;
  }
  return (
    input.signalKind === "causal-seed" || input.signalKind === "object-plant"
  );
}

/** Payoff signal must not be admitted on background callback alone. */
export function isMaterialPayoffSignal(input: {
  readonly materiality: "major" | "moderate" | "minor";
  readonly isCallbackOnly?: boolean;
}): boolean {
  if (input.isCallbackOnly) return false;
  return input.materiality !== "minor";
}

/** Minimum evidence to propose a new foreshadow thread from a hypothesis cluster. */
export function meetsNewForeshadowMinimum(input: {
  readonly setupSignalCount: number;
  readonly payoffSignalCount: number;
  readonly distinctSceneCount: number;
  readonly edgeCount: number;
  readonly hasCoreConcern: boolean;
}): boolean {
  if (!input.hasCoreConcern) return false;
  if (input.distinctSceneCount < 2) return false;
  if (input.setupSignalCount < 1) return false;
  if (input.payoffSignalCount < 1 && input.edgeCount < 1) return false;
  return true;
}
