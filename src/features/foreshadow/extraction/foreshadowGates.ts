import {
  evaluateForeshadowInvariant,
  type ForeshadowInvariantInput,
} from "./foreshadowInvariant";
import {
  evaluateForeshadowStrategy,
  type ForeshadowStrategyInput,
} from "./foreshadowStrategy";
export {
  isMaterialPayoffSignal,
  isMaterialSetupSignal,
  meetsNewForeshadowMinimum,
} from "./foreshadowSignals";

export interface ForeshadowGateInput
  extends ForeshadowInvariantInput, ForeshadowStrategyInput {}

export type ForeshadowGateDecision =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: string };

/**
 * Compatibility facade for the existing planner API. Structural ownership
 * and reading-order checks run before narrative strategy checks.
 */
export function evaluateForeshadowGate(
  input: ForeshadowGateInput,
): ForeshadowGateDecision {
  const invariant = evaluateForeshadowInvariant(input);
  if (invariant.kind === "blocked") {
    return { admit: false, reason: invariant.reason };
  }
  const strategy = evaluateForeshadowStrategy(input);
  if (strategy.kind === "reject") {
    return { admit: false, reason: strategy.reason };
  }
  return { admit: true };
}
