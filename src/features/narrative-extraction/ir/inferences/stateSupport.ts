import type { StateFacet } from "@/features/codex/details/semanticBindingTypes";

export type StatePolarity = "affirmed" | "negated" | "uncertain";

export type StateCommitment =
  | "story-fact"
  | "rumor"
  | "belief"
  | "speculation"
  | "conflicted";

export type StateSupport =
  | "direct"
  | "corroborated"
  | "inferred"
  | "weak";

export type StateNarrativeFrame =
  | "primary"
  | "memory"
  | "reported"
  | "hypothetical"
  | "other";

export type StateDurability = "transient" | "moderate" | "major";

export type StateChangeMagnitude = "minor" | "moderate" | "major";

export interface StateEpistemicContext {
  readonly polarity: StatePolarity;
  readonly commitment: StateCommitment;
  readonly support: StateSupport;
  readonly narrativeFrame: StateNarrativeFrame;
}

/**
 * Deterministic durability class for a facet key.
 *
 * Spec rules:
 * - transient emotion / scene-local location → never Phase
 * - durable injury / role change → Phase candidate
 */
export function classifyFacetDurability(facetKey: StateFacet): StateDurability {
  const key = facetKey.trim().toLowerCase();
  if (
    key.startsWith("emotion.") ||
    key.startsWith("mood.") ||
    key === "location.scene" ||
    key.startsWith("location.temporary") ||
    key.startsWith("location.scene.")
  ) {
    return "transient";
  }
  if (
    key.startsWith("role.") ||
    key.startsWith("identity.") ||
    key.includes("death") ||
    key === "status.alive" ||
    key.startsWith("injury.severe") ||
    key.startsWith("injury.major") ||
    key.startsWith("injury.permanent")
  ) {
    return "major";
  }
  if (
    key.startsWith("injury.") ||
    key.startsWith("affiliation.") ||
    key.startsWith("goal.") ||
    key.startsWith("status.") ||
    key.startsWith("condition.")
  ) {
    return "moderate";
  }
  return "moderate";
}

export function isTransientFacet(facetKey: StateFacet): boolean {
  return classifyFacetDurability(facetKey) === "transient";
}

export function isDurableFacet(facetKey: StateFacet): boolean {
  return !isTransientFacet(facetKey);
}
