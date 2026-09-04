import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { chronicleEvidenceTupleKey } from "./evidenceTupleKey";

export function mergeObservationsByEvidence(
  observations: readonly RawChronicleEventObservation[],
): readonly RawChronicleEventObservation[] {
  const seen = new Set<string>();
  const merged: RawChronicleEventObservation[] = [];
  for (const observation of observations) {
    const identity = JSON.stringify(
      observation.evidence
        .map((item) => chronicleEvidenceTupleKey(item.sourceRef, item.quote))
        .sort(),
    );
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(observation);
  }
  return merged;
}
