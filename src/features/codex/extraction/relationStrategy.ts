import type {
  CodexRelationHypothesis,
  CodexRelationValidity,
} from "@/features/narrative-extraction/ir/inferences/codexRelationHypothesis";

export type RelationStrategyDecision =
  | {
      readonly kind: "proposal";
      readonly validity: Extract<CodexRelationValidity, "timeless" | "current">;
    }
  | { readonly kind: "report-only"; readonly reason: string };

/**
 * Narrative admission strategy. This module may classify meaning, but it
 * never resolves endpoints or writes a Domain operation.
 */
export function evaluateRelationStrategy(
  hypothesis: CodexRelationHypothesis,
): RelationStrategyDecision {
  const { epistemic, payload } = hypothesis;
  if (epistemic.polarity !== "affirmed") {
    return { kind: "report-only", reason: "non-affirmed-polarity" };
  }
  if (epistemic.commitment !== "story-fact") {
    return { kind: "report-only", reason: "non-story-fact" };
  }
  if (
    epistemic.narrativeFrame !== "primary" &&
    epistemic.narrativeFrame !== "memory"
  ) {
    return { kind: "report-only", reason: "non-primary-frame" };
  }
  if (epistemic.support !== "direct" && epistemic.support !== "corroborated") {
    return { kind: "report-only", reason: "weak-support" };
  }
  if (payload.validity !== "timeless" && payload.validity !== "current") {
    return { kind: "report-only", reason: `validity:${payload.validity}` };
  }
  return { kind: "proposal", validity: payload.validity };
}
