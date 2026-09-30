import type { ForeshadowSetupSignalKind } from "@/features/narrative-extraction/ir/inferences/foreshadowSetupSignal";

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
