import type { EntityReference } from "@/features/narrative-extraction/ir/observations/entityIdentity";
import type { EntityRelationObservation } from "@/features/narrative-extraction/ir/observations/entityRelation";
import type { NarrativeEntityId } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import type { EntityRelationFamily } from "@/features/narrative-extraction/ir/observations/entityRelation";

export interface RelationCandidateIndexEntry {
  readonly candidateId: string;
  readonly subjectEntityId: NarrativeEntityId;
  readonly objectEntityId: NarrativeEntityId;
  readonly observationIds: readonly string[];
  readonly predicates: readonly string[];
  readonly families: readonly EntityRelationFamily[];
}

export interface RelationCandidateIndex {
  readonly entries: readonly RelationCandidateIndexEntry[];
}

export interface BuildRelationCandidateIndexOptions {
  readonly resolveEntityId: (
    ref: EntityReference,
  ) => NarrativeEntityId | null;
  readonly createId?: () => string;
}

/**
 * Index EntityRelation observations by resolved narrative entity pair.
 * Unresolved ends are dropped (not proposed).
 */
export function buildRelationCandidateIndex(
  observations: readonly EntityRelationObservation[],
  options: BuildRelationCandidateIndexOptions,
): RelationCandidateIndex {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const groups = new Map<
    string,
    {
      subjectEntityId: NarrativeEntityId;
      objectEntityId: NarrativeEntityId;
      observationIds: string[];
      predicates: string[];
      families: EntityRelationFamily[];
    }
  >();

  for (const observation of observations) {
    if (observation.kind !== "entity-relation") continue;
    const subjectEntityId = options.resolveEntityId(
      observation.payload.subject,
    );
    const objectEntityId = options.resolveEntityId(observation.payload.object);
    if (!subjectEntityId || !objectEntityId) continue;
    if (subjectEntityId === objectEntityId) continue;

    const key = `${subjectEntityId}\0${objectEntityId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.observationIds.push(observation.localId);
      existing.predicates.push(observation.payload.predicate);
      existing.families.push(observation.payload.family);
      continue;
    }
    groups.set(key, {
      subjectEntityId,
      objectEntityId,
      observationIds: [observation.localId],
      predicates: [observation.payload.predicate],
      families: [observation.payload.family],
    });
  }

  return {
    entries: [...groups.values()].map((group) => ({
      candidateId: createId(),
      subjectEntityId: group.subjectEntityId,
      objectEntityId: group.objectEntityId,
      observationIds: group.observationIds,
      predicates: group.predicates,
      families: group.families,
    })),
  };
}
