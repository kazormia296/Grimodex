import type { StateTrackHypothesis } from "@/features/narrative-extraction/ir/inferences/stateTrack";
import type { StateEpistemicContext } from "@/features/narrative-extraction/ir/inferences/stateSupport";
import { classifyFacetDurability } from "@/features/narrative-extraction/ir/inferences/stateSupport";
import type { StateObservationIndex } from "./stateObservationIndex";
import type { StateTrackManifest } from "./stateTrackManifest";

const DEFAULT_EPISTEMIC: StateEpistemicContext = {
  polarity: "affirmed",
  commitment: "story-fact",
  support: "direct",
  narrativeFrame: "primary",
};

export interface SynthesizeStateTracksOptions {
  readonly createId?: () => string;
  readonly epistemic?: StateEpistemicContext;
  /**
   * Optional AI hook placeholder — when provided, may enrich tracks later.
   * Deterministic synthesis is the v1 source of truth.
   */
  readonly aiEnrich?: (
    tracks: readonly StateTrackHypothesis[],
  ) =>
    | Promise<readonly StateTrackHypothesis[]>
    | readonly StateTrackHypothesis[];
}

/**
 * Deterministic State Track synthesis from the observation index + manifest.
 * Transient facets are kept as tracks (for Detail/report) but never promote
 * to Phase boundaries downstream.
 */
export function synthesizeStateTracks(
  index: StateObservationIndex,
  manifest: StateTrackManifest,
  options: SynthesizeStateTracksOptions = {},
): readonly StateTrackHypothesis[] {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const epistemic = options.epistemic ?? DEFAULT_EPISTEMIC;
  const byKey = index.byEntityFacet;
  const tracks: StateTrackHypothesis[] = [];

  for (const entry of manifest.entries) {
    const key = `${entry.entityId}\0${entry.facetKey}`;
    const points = byKey.get(key) ?? [];
    if (points.length === 0) continue;

    const durability = classifyFacetDurability(entry.facetKey);
    tracks.push({
      trackId: createId(),
      observationRefs: points.map((point) => point.observationId),
      payload: {
        entityId: entry.entityId,
        facetKey: entry.facetKey,
        durability,
        points: points.map((point) => ({
          observationId: point.observationId,
          value: point.value,
          temporalMode: point.temporalMode,
          anchorDocumentRef: point.anchorDocumentRef,
          retrospectiveOnly: point.retrospectiveOnly,
          durability: point.durability,
        })),
      },
      epistemic,
    });
  }

  return tracks;
}

/** Optional async wrapper that applies an AI enrich hook when present. */
export async function synthesizeStateTracksAsync(
  index: StateObservationIndex,
  manifest: StateTrackManifest,
  options: SynthesizeStateTracksOptions = {},
): Promise<readonly StateTrackHypothesis[]> {
  const tracks = synthesizeStateTracks(index, manifest, options);
  if (!options.aiEnrich) return tracks;
  return options.aiEnrich(tracks);
}
