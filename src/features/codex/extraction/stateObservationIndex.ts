import type { EntityReference } from "@/features/narrative-extraction/ir/observations/entityIdentity";
import type { StateAssertionObservation } from "@/features/narrative-extraction/ir/observations/stateAssertion";
import type { NarrativeEntityId } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import {
  classifyFacetDurability,
  type StateDurability,
} from "@/features/narrative-extraction/ir/inferences/stateSupport";

export interface StateObservationIndexEntry {
  readonly observationId: string;
  readonly entityId: NarrativeEntityId;
  readonly facetKey: string;
  readonly durability: StateDurability;
  readonly temporalMode: StateAssertionObservation["payload"]["temporalMode"];
  readonly aspect: StateAssertionObservation["payload"]["aspect"];
  readonly value: StateAssertionObservation["payload"]["value"];
  readonly anchorDocumentRef: string | null;
  readonly retrospectiveOnly: boolean;
}

export interface StateObservationIndex {
  readonly entries: readonly StateObservationIndexEntry[];
  readonly byEntityFacet: ReadonlyMap<
    string,
    readonly StateObservationIndexEntry[]
  >;
}

export interface BuildStateObservationIndexOptions {
  readonly resolveEntityId: (ref: EntityReference) => NarrativeEntityId | null;
}

function entityFacetKey(entityId: string, facetKey: string): string {
  return `${entityId}\0${facetKey}`;
}

/**
 * Index StateAssertion observations by resolved Narrative Entity + facet.
 * Unresolved subjects are dropped.
 */
export function buildStateObservationIndex(
  observations: readonly StateAssertionObservation[],
  options: BuildStateObservationIndexOptions,
): StateObservationIndex {
  const entries: StateObservationIndexEntry[] = [];
  const groups = new Map<string, StateObservationIndexEntry[]>();

  for (const observation of observations) {
    if (observation.kind !== "state-assertion") continue;
    const entityId = options.resolveEntityId(observation.payload.subject);
    if (!entityId) continue;

    const durability =
      observation.payload.durabilityHint ??
      classifyFacetDurability(observation.payload.facetKey);

    const entry: StateObservationIndexEntry = {
      observationId: observation.localId,
      entityId,
      facetKey: observation.payload.facetKey,
      durability,
      temporalMode: observation.payload.temporalMode,
      aspect: observation.payload.aspect,
      value: observation.payload.value,
      anchorDocumentRef: observation.payload.anchorDocumentRef ?? null,
      retrospectiveOnly: observation.payload.retrospectiveOnly === true,
    };
    entries.push(entry);

    const key = entityFacetKey(entityId, entry.facetKey);
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }

  return {
    entries,
    byEntityFacet: groups,
  };
}
