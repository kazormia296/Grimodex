import type {
  CodexRelationDirectionality,
  CodexRelationHypothesis,
  CodexRelationValidity,
} from "@/features/narrative-extraction/ir/inferences/codexRelationHypothesis";
import type { EntityRelationFamily } from "@/features/narrative-extraction/ir/observations/entityRelation";

export type RelationInvariantDecision =
  | { readonly kind: "valid" }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Runtime ownership context for structural relation checks.
 * The IR normally carries opaque entity ids only, so project ownership is
 * optional until the caller has resolved both endpoints to a project.
 */
export interface RelationInvariantContext {
  readonly subjectProjectId?: string | null;
  readonly objectProjectId?: string | null;
}

const FAMILIES = new Set<EntityRelationFamily>([
  "identity",
  "kinship",
  "social",
  "affiliation",
  "possessive",
  "spatial",
  "part-whole",
  "comparative",
  "other",
]);

const VALIDITIES = new Set<CodexRelationValidity>([
  "timeless",
  "current",
  "historical",
  "prospective",
  "ended",
  "unknown",
]);

const DIRECTIONALITIES = new Set<CodexRelationDirectionality>([
  "directed",
  "symmetric",
  "ambiguous",
]);

/**
 * Structural relation invariants only. Narrative meaning is deliberately
 * absent here so a semantically unusual but well-formed relation can still
 * reach the strategy gate and human review.
 */
export function evaluateRelationInvariant(
  hypothesis: CodexRelationHypothesis,
  context: RelationInvariantContext = {},
): RelationInvariantDecision {
  const { payload } = hypothesis;
  if (!hypothesis.subjectResolved || !hypothesis.objectResolved) {
    return { kind: "blocked", reason: "unresolved-endpoint" };
  }
  if (!payload.subjectEntityId || !payload.objectEntityId) {
    return { kind: "blocked", reason: "missing-endpoint" };
  }
  if (payload.subjectEntityId === payload.objectEntityId) {
    return { kind: "blocked", reason: "self-relation" };
  }
  if (
    context.subjectProjectId != null &&
    context.objectProjectId != null &&
    context.subjectProjectId !== context.objectProjectId
  ) {
    return { kind: "blocked", reason: "cross-project-endpoint" };
  }
  if (!FAMILIES.has(payload.family)) {
    return { kind: "blocked", reason: "invalid-relation-family" };
  }
  if (!VALIDITIES.has(payload.validity)) {
    return { kind: "blocked", reason: "invalid-validity" };
  }
  if (!DIRECTIONALITIES.has(payload.directionality)) {
    return { kind: "blocked", reason: "invalid-directionality" };
  }
  if (payload.directionality === "ambiguous") {
    return { kind: "blocked", reason: "ambiguous-directionality" };
  }
  if (!payload.predicate.trim()) {
    return { kind: "blocked", reason: "missing-predicate" };
  }
  if (!payload.forwardLabelSuggestion.trim()) {
    return { kind: "blocked", reason: "missing-forward-label" };
  }
  return { kind: "valid" };
}
