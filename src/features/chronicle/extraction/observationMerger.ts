import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";

function evidenceFingerprint(sourceRef: string, quote: string): string {
  return `${sourceRef}\0${quote}`;
}

export function mergeObservationsByEvidence(
  observations: readonly RawChronicleEventObservation[],
): readonly RawChronicleEventObservation[] {
  const seen = new Set<string>();
  const merged: RawChronicleEventObservation[] = [];
  for (const observation of observations) {
    const key = observation.evidence
      .map((item) => evidenceFingerprint(item.sourceRef, item.quote))
      .sort()
      .join("||");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(observation);
  }
  return merged;
}
