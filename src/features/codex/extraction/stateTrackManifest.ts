import type { NarrativeEntityId } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import type { StateObservationIndex } from "./stateObservationIndex";

export interface StateTrackManifestEntry {
  readonly manifestId: string;
  readonly entityId: NarrativeEntityId;
  readonly facetKey: string;
  readonly observationIds: readonly string[];
}

export interface StateTrackManifest {
  readonly entries: readonly StateTrackManifestEntry[];
}

export interface BuildStateTrackManifestOptions {
  readonly createId?: () => string;
}

/**
 * One manifest row per (entityId, facetKey) with ≥1 indexed observation.
 */
export function buildStateTrackManifest(
  index: StateObservationIndex,
  options: BuildStateTrackManifestOptions = {},
): StateTrackManifest {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const entries: StateTrackManifestEntry[] = [];

  for (const [key, bucket] of index.byEntityFacet) {
    const separator = key.indexOf("\0");
    const entityId = key.slice(0, separator);
    const facetKey = key.slice(separator + 1);
    entries.push({
      manifestId: createId(),
      entityId,
      facetKey,
      observationIds: bucket.map((entry) => entry.observationId),
    });
  }

  return { entries };
}
