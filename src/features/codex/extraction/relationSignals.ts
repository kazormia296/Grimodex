import type {
  CodexRelationDirectionality,
  CodexRelationHypothesis,
  CodexRelationValidity,
  RelationCommitment,
  RelationEpistemicContext,
  RelationNarrativeFrame,
  RelationPolarity,
  RelationSupport,
} from "@/features/narrative-extraction/ir/inferences/codexRelationHypothesis";
import type { EntityRelationFamily } from "@/features/narrative-extraction/ir/observations/entityRelation";

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

const POLARITIES = new Set<RelationPolarity>([
  "affirmed",
  "negated",
  "uncertain",
]);

const COMMITMENTS = new Set<RelationCommitment>([
  "story-fact",
  "rumor",
  "belief",
  "speculation",
  "conflicted",
]);

const SUPPORTS = new Set<RelationSupport>([
  "direct",
  "corroborated",
  "inferred",
  "weak",
]);

const FRAMES = new Set<RelationNarrativeFrame>([
  "primary",
  "memory",
  "reported",
  "hypothetical",
  "other",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export interface NormalizeRelationSynthesisOptions {
  readonly candidateRef: string;
  readonly allowedObservationRefs: ReadonlySet<string>;
  readonly resolvedEntityIds: ReadonlySet<string>;
  readonly createId?: () => string;
}

/**
 * Normalize AI relation signals into opaque IR hypotheses. Exact names,
 * aliases, and co-mention observations stay evidence refs; this layer does
 * not decide whether their narrative meaning is admissible.
 */
export function normalizeRelationSynthesis(
  raw: unknown,
  options: NormalizeRelationSynthesisOptions,
): readonly CodexRelationHypothesis[] {
  if (!isRecord(raw)) return [];
  if (asString(raw.candidateRef) !== options.candidateRef) return [];
  if (!Array.isArray(raw.relations)) return [];

  const createId = options.createId ?? (() => crypto.randomUUID());
  const hypotheses: CodexRelationHypothesis[] = [];

  for (const row of raw.relations) {
    if (!isRecord(row)) continue;
    const observationRefs = Array.isArray(row.observationRefs)
      ? row.observationRefs
          .filter((ref): ref is string => typeof ref === "string")
          .filter((ref) => options.allowedObservationRefs.has(ref))
      : [];
    if (observationRefs.length === 0) continue;

    const subjectEntityId = asString(row.subjectEntityId);
    const objectEntityId = asString(row.objectEntityId);
    const predicate = asString(row.predicate)?.trim() ?? "";
    const family = asString(row.family);
    const validity = asString(row.validity);
    const directionality = asString(row.directionality);
    const forwardLabelSuggestion =
      asString(row.forwardLabelSuggestion)?.trim() ?? "";
    const inverseRaw = row.inverseLabelSuggestion;
    const inverseLabelSuggestion =
      inverseRaw === null ? null : (asString(inverseRaw)?.trim() ?? null);
    const polarity = asString(row.polarity);
    const commitment = asString(row.commitment);
    const support = asString(row.support);
    const narrativeFrame = asString(row.narrativeFrame);

    if (
      !subjectEntityId ||
      !objectEntityId ||
      !predicate ||
      !family ||
      !validity ||
      !directionality ||
      !forwardLabelSuggestion ||
      !polarity ||
      !commitment ||
      !support ||
      !narrativeFrame
    ) {
      continue;
    }
    if (!FAMILIES.has(family as EntityRelationFamily)) continue;
    if (!VALIDITIES.has(validity as CodexRelationValidity)) continue;
    if (!DIRECTIONALITIES.has(directionality as CodexRelationDirectionality)) {
      continue;
    }
    if (!POLARITIES.has(polarity as RelationPolarity)) continue;
    if (!COMMITMENTS.has(commitment as RelationCommitment)) continue;
    if (!SUPPORTS.has(support as RelationSupport)) continue;
    if (!FRAMES.has(narrativeFrame as RelationNarrativeFrame)) continue;

    const epistemic: RelationEpistemicContext = {
      polarity: polarity as RelationPolarity,
      commitment: commitment as RelationCommitment,
      support: support as RelationSupport,
      narrativeFrame: narrativeFrame as RelationNarrativeFrame,
    };

    hypotheses.push({
      hypothesisId: createId(),
      observationRefs,
      subjectResolved: options.resolvedEntityIds.has(subjectEntityId),
      objectResolved: options.resolvedEntityIds.has(objectEntityId),
      payload: {
        subjectEntityId,
        objectEntityId,
        predicate,
        family: family as EntityRelationFamily,
        validity: validity as CodexRelationValidity,
        directionality: directionality as CodexRelationDirectionality,
        forwardLabelSuggestion,
        inverseLabelSuggestion,
      },
      epistemic,
    });
  }

  return hypotheses;
}
