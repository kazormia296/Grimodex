import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";

export interface EventObservationCluster {
  readonly clusterRef: string;
  readonly observationRefs: readonly string[];
  readonly blockingKey: string;
}

function normalizeSurface(value: string): string {
  return value.trim().normalize("NFC").toLocaleLowerCase("und");
}

function blockingKeyFor(observation: RawChronicleEventObservation): string {
  const participants = observation.payload.participants
    .map((participant) => normalizeSurface(participant.surface))
    .filter((surface) => surface.length > 0)
    .sort()
    .join(",");
  const location = normalizeSurface(observation.payload.locationSurface ?? "");
  const temporal = observation.payload.temporalExpressions
    .map(normalizeSurface)
    .filter((item) => item.length > 0)
    .sort()
    .join(",");
  const semantic = normalizeSurface(observation.payload.semanticType ?? "");
  const predicate = normalizeSurface(observation.payload.predicate).slice(0, 48);
  // Blocking key — not a full pairwise similarity. Same key → same cluster.
  return [semantic || "unk", participants || "-", location || "-", temporal || "-", predicate].join(
    "|",
  );
}

/**
 * Deterministic candidate clustering. Observations that share a blocking key
 * (predicate prefix + entities + place + time + semantic type) form one cluster.
 * Does not run O(N²) pairwise comparison.
 */
export function clusterEventObservations(
  observations: readonly RawChronicleEventObservation[],
): readonly EventObservationCluster[] {
  const buckets = new Map<string, string[]>();
  for (const observation of observations) {
    const key = blockingKeyFor(observation);
    const bucket = buckets.get(key) ?? [];
    bucket.push(observation.localId);
    buckets.set(key, bucket);
  }

  const clusters: EventObservationCluster[] = [];
  let index = 0;
  for (const [blockingKey, observationRefs] of buckets) {
    clusters.push({
      clusterRef: `cluster-${String(++index).padStart(4, "0")}`,
      observationRefs,
      blockingKey,
    });
  }
  return clusters;
}
