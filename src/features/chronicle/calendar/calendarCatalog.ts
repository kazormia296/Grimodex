import { freezeDeep } from "@/features/narrative-extraction/source/immutability";
import type {
  ExtractionCalendarEra,
  ExtractionCalendarMonth,
  ExtractionCalendarSeason,
  ExtractionCalendarSnapshot,
} from "./extractionCalendarSnapshot";
import { verifyExtractionCalendarSnapshot } from "./extractionCalendarSnapshot";

export interface ExtractionCalendarCatalog {
  readonly calendarRef: ExtractionCalendarSnapshot["calendarRef"];
  readonly calendarDigest: ExtractionCalendarSnapshot["digest"];
  readonly resolveMonth: (ref: string) => ExtractionCalendarMonth | null;
  readonly resolveSeason: (ref: string) => ExtractionCalendarSeason | null;
  readonly resolveEra: (ref: string) => ExtractionCalendarEra | null;
}

/** Exact opaque-ref lookup. Unknown names or refs never select a default. */
export async function createCalendarCatalog(
  untrustedSnapshot: unknown,
): Promise<ExtractionCalendarCatalog> {
  const verification =
    await verifyExtractionCalendarSnapshot(untrustedSnapshot);
  if (!verification.ok) {
    throw new TypeError("Invalid Extraction Calendar Snapshot");
  }
  const snapshot: ExtractionCalendarSnapshot = verification.snapshot;
  const months = new Map(snapshot.months.map((item) => [item.ref, item]));
  const seasons = new Map(snapshot.seasons.map((item) => [item.ref, item]));
  const eras = new Map(snapshot.eras.map((item) => [item.ref, item]));
  return freezeDeep({
    calendarRef: snapshot.calendarRef,
    calendarDigest: snapshot.digest,
    resolveMonth: (ref: string) => months.get(ref) ?? null,
    resolveSeason: (ref: string) => seasons.get(ref) ?? null,
    resolveEra: (ref: string) => eras.get(ref) ?? null,
  });
}
