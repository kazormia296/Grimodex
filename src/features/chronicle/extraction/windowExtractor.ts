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

/**
 * Re-key window-local observation IDs into globally unique IDs.
 * Scheme: `{windowKey}:obs-{paddedSeq}` (1-based, 3-digit).
 * Does not trust model localIds as global identifiers.
 */
export function rekeyObservationsForWindow(
  windowKey: string,
  observations: readonly RawChronicleEventObservation[],
): readonly RawChronicleEventObservation[] {
  return observations.map((observation, index) => ({
    ...observation,
    localId: `${windowKey}:obs-${String(index + 1).padStart(3, "0")}`,
  }));
}

/** Fail-closed uniqueness check for observation localIds. */
export function assertUniqueObservationLocalIds(
  observations: readonly RawChronicleEventObservation[],
): void {
  const seen = new Set<string>();
  for (const observation of observations) {
    if (seen.has(observation.localId)) {
      throw new Error(
        `Duplicate observation localId after window collection: ${observation.localId}`,
      );
    }
    seen.add(observation.localId);
  }
}
