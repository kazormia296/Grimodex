import type { CodexRelationHypothesis } from "@/features/narrative-extraction/ir/inferences/codexRelationHypothesis";
import {
  evaluateRelationInvariant,
  type RelationInvariantContext,
} from "./relationInvariant";
import {
  evaluateRelationStrategy,
  type RelationStrategyDecision,
} from "./relationStrategy";
export {
  normalizeRelationSynthesis,
  type NormalizeRelationSynthesisOptions,
} from "./relationSignals";

export type RelationDomainGateDecision =
  | Extract<ReturnType<typeof evaluateRelationInvariant>, { kind: "blocked" }>
  | RelationStrategyDecision;

/**
 * Compose structural invariants and narrative strategy while preserving the
 * existing public gate API for proposal planners.
 */
export function evaluateRelationDomainGate(
  hypothesis: CodexRelationHypothesis,
  context?: RelationInvariantContext,
): RelationDomainGateDecision {
  const invariant = evaluateRelationInvariant(hypothesis, context);
  if (invariant.kind === "blocked") return invariant;
  return evaluateRelationStrategy(hypothesis);
}
