import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import {
  parseRawChronicleEventObservation,
  parseRawChronicleEventObservationList,
} from "./schemas";

export interface NormalizeObservationsOptions {
  readonly allowedSourceRefs: ReadonlySet<string>;
  readonly createId?: () => string;
}

/**
 * Normalize AI observation output: drop unknown source refs, fill missing
 * localIds, and reject structurally invalid rows.
 */
export function normalizeWindowObservations(
  raw: unknown,
  options: NormalizeObservationsOptions,
): readonly RawChronicleEventObservation[] {
  const listResult = parseRawChronicleEventObservationList(raw);
  const candidates = listResult.ok
    ? listResult.value
    : Array.isArray((raw as { observations?: unknown })?.observations)
      ? ((raw as { observations: unknown[] }).observations
          .map((item) => parseRawChronicleEventObservation(item))
          .filter((item) => item.ok)
          .map((item) => item.value) as RawChronicleEventObservation[])
      : [];

  const createId = options.createId ?? (() => crypto.randomUUID());
  const out: RawChronicleEventObservation[] = [];

  for (const observation of candidates) {
    const evidence = observation.evidence.filter((item) =>
      options.allowedSourceRefs.has(item.sourceRef),
    );
    if (evidence.length === 0) continue;
    out.push({
      ...observation,
      localId: observation.localId.trim() || createId(),
      evidence,
    });
  }

  return out;
}
