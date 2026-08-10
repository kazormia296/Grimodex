import type {
  PlotThreadCore,
  PlotThreadExistingResolution,
} from "@/features/narrative-extraction/ir/inferences/plotThreadHypothesis";

export type ExistingPlotThreadRef = `PT${string}`;

export interface ExistingPlotThreadCatalogRecord {
  readonly ref: ExistingPlotThreadRef;
  readonly name: string;
  readonly coreKind: PlotThreadCore["kind"];
  /** documentRef of every marker already placed on this thread. */
  readonly markerDocumentRefs: readonly string[];
  /**
   * Application Provenance keys (e.g. bind proposal fingerprints) previously
   * applied for this thread. Exact membership → resolved.
   */
  readonly applicationProvenanceKeys?: readonly string[];
}

export interface MatchExistingPlotThreadInput {
  readonly nameSuggestion: string;
  readonly coreKind: PlotThreadCore["kind"];
  readonly markerDocumentRefs: readonly string[];
  readonly provenanceKeys?: readonly string[];
}

function normalizeName(name: string): string {
  return name.trim().normalize("NFC").toLocaleLowerCase("und");
}

function hasOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

/**
 * Deterministic existing-thread match, mirroring
 * chronicle/extraction/existingEventMatcher's admission discipline.
 * - Application Provenance hit → resolved (application-provenance)
 * - Name + core kind + ≥1 shared marker document → resolved (core-and-marker-overlap)
 * - Name-only → ambiguous (NEVER auto-bind)
 * - Otherwise → none
 */
export function matchExistingPlotThread(
  input: MatchExistingPlotThreadInput,
  catalog: readonly ExistingPlotThreadCatalogRecord[],
): PlotThreadExistingResolution {
  const targetName = normalizeName(input.nameSuggestion);
  const provenance = new Set(input.provenanceKeys ?? []);

  for (const record of catalog) {
    const provenanceKeys = record.applicationProvenanceKeys ?? [];
    if (
      provenanceKeys.length > 0 &&
      provenanceKeys.some((key) => provenance.has(key))
    ) {
      return {
        status: "resolved",
        ref: record.ref,
        method: "application-provenance",
      };
    }
  }

  const nameMatches = catalog.filter(
    (record) => normalizeName(record.name) === targetName,
  );
  if (nameMatches.length === 0) {
    return { status: "none" };
  }

  const overlapMatch = nameMatches.find(
    (record) =>
      record.coreKind === input.coreKind &&
      hasOverlap(record.markerDocumentRefs, input.markerDocumentRefs),
  );
  if (overlapMatch) {
    return {
      status: "resolved",
      ref: overlapMatch.ref,
      method: "core-and-marker-overlap",
    };
  }

  return {
    status: "ambiguous",
    candidates: nameMatches.map((record) => ({
      ref: record.ref,
      score: record.coreKind === input.coreKind ? 0.6 : 0.4,
      reasons:
        record.coreKind === input.coreKind
          ? ["name-only", "core-kind-match"]
          : ["name-only"],
    })),
  };
}
