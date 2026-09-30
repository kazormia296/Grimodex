import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { chronicleEvidenceTupleKey } from "./evidenceTupleKey";

export function mergeObservationsByEvidence(
  observations: readonly RawChronicleEventObservation[],
): readonly RawChronicleEventObservation[] {
  const seen = new Set<string>();
  const merged: RawChronicleEventObservation[] = [];
  for (const observation of observations) {
    // Evidence is a set of occurrences, while the remaining fields describe
    // the claim made about those occurrences. A sentence can support more
    // than one predicate, actuality, participant role, or narrative frame;
    // those rows must not be collapsed merely because their evidence matches.
    // localId is intentionally omitted so window re-keying does not prevent
    // exact duplicate rows from coalescing.
    const identity = JSON.stringify({
      evidence: observation.evidence
        .map((item) => chronicleEvidenceTupleKey(item.sourceRef, item.quote))
        .sort(),
      assertion: {
        attribution: observation.assertion.attribution,
        narrativeFrame: observation.assertion.narrativeFrame,
      },
      payload: {
        predicate: observation.payload.predicate,
        semanticType: observation.payload.semanticType ?? null,
        actuality: observation.payload.actuality,
        participants: observation.payload.participants,
        locationSurface: observation.payload.locationSurface ?? null,
        temporalExpressions: observation.payload.temporalExpressions,
        durationKind: observation.payload.durationKind,
      },
    });
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(observation);
  }
  return merged;
}
