import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type {
  EventObservationActuality,
  RawChronicleEventObservation,
} from "@/features/narrative-extraction/ir/observations/eventOccurrence";

export type ObservationActualityRejectionReason =
  | "empty-observation-refs"
  | "missing-observation-ref"
  | "ambiguous-observation-ref"
  | "mixed-observation-actualities";

export type HypothesisActualityRejectionReason =
  | ObservationActualityRejectionReason
  | "hypothesis-observation-actuality-mismatch";

export interface RejectedHypothesisActuality {
  readonly hypothesisId: string;
  readonly reason: HypothesisActualityRejectionReason;
}

/** Conservative, order-independent support check. No source or model row is rewritten. */
export function resolveReferencedObservationActuality(
  observationRefs: readonly string[],
  observations: readonly RawChronicleEventObservation[],
):
  | { readonly ok: true; readonly actuality: EventObservationActuality }
  | {
      readonly ok: false;
      readonly reason: ObservationActualityRejectionReason;
    } {
  if (observationRefs.length === 0) {
    return { ok: false, reason: "empty-observation-refs" };
  }
  const byId = new Map<string, RawChronicleEventObservation[]>();
  for (const observation of observations) {
    const rows = byId.get(observation.localId) ?? [];
    rows.push(observation);
    byId.set(observation.localId, rows);
  }
  const referencedRows = observationRefs.map((ref) => byId.get(ref));
  // Fixed precedence keeps the diagnostic stable when several defects coexist.
  if (referencedRows.some((rows) => !rows)) {
    return { ok: false, reason: "missing-observation-ref" };
  }
  if (referencedRows.some((rows) => rows!.length !== 1)) {
    return { ok: false, reason: "ambiguous-observation-ref" };
  }
  const actualities = new Set(
    referencedRows.map((rows) => rows![0]!.payload.actuality),
  );
  if (actualities.size !== 1) {
    return { ok: false, reason: "mixed-observation-actualities" };
  }
  return { ok: true, actuality: referencedRows[0]![0]!.payload.actuality };
}

export function checkHypothesisActuality(
  hypothesis: EventHypothesis,
  observations: readonly RawChronicleEventObservation[],
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: HypothesisActualityRejectionReason;
    } {
  const support = resolveReferencedObservationActuality(
    hypothesis.observationRefs,
    observations,
  );
  if (!support.ok) return support;
  return support.actuality === hypothesis.actuality
    ? { ok: true }
    : { ok: false, reason: "hypothesis-observation-actuality-mismatch" };
}
