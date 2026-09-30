import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";

export type ExistingEventRef = string;

export interface ExistingChronicleEventCatalogRecord {
  readonly ref: ExistingEventRef;
  readonly sourceKey: string;
  readonly title: string;
  readonly note: string | null;
  readonly version: number;
  readonly linkedDocumentSourceKeys: readonly string[];
  readonly participantEntityRefs: readonly string[];
  readonly startTime: number | null;
  readonly endTime: number | null;
  readonly digest: Sha256Digest | string;
  /**
   * Application Provenance keys (e.g. observation evidence fingerprints)
   * previously applied for this event. Exact membership → already-satisfied.
   */
  readonly applicationProvenanceKeys?: readonly string[];
}

export type ChronicleExistingMatch =
  | { readonly status: "none" }
  | {
      readonly status: "already-satisfied";
      readonly existingRef: ExistingEventRef;
    }
  | {
      readonly status: "probable-duplicate";
      readonly candidates: readonly ExistingEventRef[];
      readonly reasons: readonly string[];
    };

export interface MatchExistingEventInput {
  readonly hypothesis: EventHypothesis;
  readonly evidenceDocumentSourceKeys: readonly string[];
  readonly provenanceKeys?: readonly string[];
}

function normalizeTitle(title: string): string {
  return title.trim().normalize("NFC").toLocaleLowerCase("und");
}

export function sameChronicleEventTitle(left: string, right: string): boolean {
  return normalizeTitle(left) === normalizeTitle(right);
}

/**
 * Re-evaluate a human-edited title against the immutable catalog sealed by
 * the Run. The edit cannot change evidence/provenance, so every title hit is
 * conservatively a probable duplicate and still requires an explicit choice.
 */
export function matchChronicleEventTitleAgainstCatalog(
  title: string,
  catalog: readonly ExistingChronicleEventCatalogRecord[],
): ChronicleExistingMatch {
  const candidates = catalog
    .filter((record) => sameChronicleEventTitle(record.title, title))
    .map((record) => record.ref);
  return candidates.length === 0
    ? { status: "none" }
    : {
        status: "probable-duplicate",
        candidates,
        reasons: ["title-only"],
      };
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

/**
 * Deterministic existing-event match.
 * - Application Provenance hit → already-satisfied
 * - Title + linked scene/document set match → already-satisfied
 * - Title-only → probable-duplicate (NEVER auto-skip)
 * - Otherwise → none
 */
export function matchExistingChronicleEvent(
  input: MatchExistingEventInput,
  catalog: readonly ExistingChronicleEventCatalogRecord[],
): ChronicleExistingMatch {
  const hypothesisTitle = normalizeTitle(input.hypothesis.titleSuggestion);
  const provenance = new Set(input.provenanceKeys ?? []);

  for (const record of catalog) {
    const provenanceKeys = record.applicationProvenanceKeys ?? [];
    if (
      provenanceKeys.length > 0 &&
      provenanceKeys.some((key) => provenance.has(key))
    ) {
      return { status: "already-satisfied", existingRef: record.ref };
    }
  }

  const titleMatches = catalog.filter(
    (record) => normalizeTitle(record.title) === hypothesisTitle,
  );
  if (titleMatches.length === 0) {
    return { status: "none" };
  }

  const sceneSatisfied = titleMatches.find((record) =>
    sameStringSet(
      [...record.linkedDocumentSourceKeys].sort(),
      [...input.evidenceDocumentSourceKeys].sort(),
    ),
  );
  if (
    sceneSatisfied &&
    input.evidenceDocumentSourceKeys.length > 0 &&
    sceneSatisfied.linkedDocumentSourceKeys.length > 0
  ) {
    return {
      status: "already-satisfied",
      existingRef: sceneSatisfied.ref,
    };
  }

  return {
    status: "probable-duplicate",
    candidates: titleMatches.map((record) => record.ref),
    reasons: ["title-only"],
  };
}
