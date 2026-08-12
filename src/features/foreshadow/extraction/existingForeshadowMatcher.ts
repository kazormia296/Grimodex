import type {
  ForeshadowExistingResolution,
  ForeshadowThreadCore,
  ForeshadowThreadHypothesisPayload,
} from "@/features/narrative-extraction/ir/inferences/foreshadowThreadHypothesis";

export type ExistingForeshadowRef = `FS${string}`;

export interface ExistingForeshadowCatalogRecord {
  readonly ref: ExistingForeshadowRef;
  readonly title: string;
  readonly coreBridgeKind: ForeshadowThreadCore["bridgeKind"];
  readonly setupDocumentRefs: readonly string[];
  readonly payoffDocumentRef: string | null;
  readonly payoffConfirmed: boolean;
  readonly applicationProvenanceKeys?: readonly string[];
}

export interface MatchExistingForeshadowInput {
  readonly titleSuggestion: string;
  readonly coreBridgeKind: ForeshadowThreadCore["bridgeKind"];
  readonly setupDocumentRefs: readonly string[];
  readonly payoffDocumentRef: string | null;
  readonly provenanceKeys?: readonly string[];
}

function normalizeTitle(title: string): string {
  return title.trim().normalize("NFC").toLocaleLowerCase("und");
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
 * Deterministic existing-foreshadow match.
 * - Application Provenance hit → resolved
 * - Title + bridge kind + ≥1 shared setup doc → resolved
 * - Setup+payoff already present on record → already-satisfied
 * - Title-only → ambiguous (NEVER auto-bind)
 * - Otherwise → none
 */
export function matchExistingForeshadow(
  input: MatchExistingForeshadowInput,
  catalog: readonly ExistingForeshadowCatalogRecord[],
): ForeshadowExistingResolution {
  const provenance = new Set(input.provenanceKeys ?? []);

  for (const record of catalog) {
    const keys = record.applicationProvenanceKeys ?? [];
    if (keys.length > 0 && keys.some((key) => provenance.has(key))) {
      return {
        status: "resolved",
        ref: record.ref,
        method: "application-provenance",
      };
    }
  }

  const targetTitle = normalizeTitle(input.titleSuggestion);
  const titleMatches = catalog.filter(
    (record) => normalizeTitle(record.title) === targetTitle,
  );
  if (titleMatches.length === 0) {
    return { status: "none" };
  }

  for (const record of titleMatches) {
    const setupOverlap = hasOverlap(
      record.setupDocumentRefs,
      input.setupDocumentRefs,
    );
    const payoffMatch =
      record.payoffDocumentRef != null &&
      record.payoffDocumentRef === input.payoffDocumentRef;
    if (
      record.coreBridgeKind === input.coreBridgeKind &&
      setupOverlap &&
      record.payoffConfirmed &&
      payoffMatch
    ) {
      return {
        status: "already-satisfied",
        ref: record.ref,
        reason: "setup-and-payoff-present",
      };
    }
  }

  const overlapMatch = titleMatches.find(
    (record) =>
      record.coreBridgeKind === input.coreBridgeKind &&
      hasOverlap(record.setupDocumentRefs, input.setupDocumentRefs),
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
    candidates: titleMatches.map((record) => ({
      ref: record.ref,
      score: record.coreBridgeKind === input.coreBridgeKind ? 0.6 : 0.4,
      reasons:
        record.coreBridgeKind === input.coreBridgeKind
          ? ["name-only", "bridge-kind-match"]
          : ["name-only"],
    })),
  };
}

export function distinctDocumentRefs(
  hypothesis: ForeshadowThreadHypothesisPayload,
): readonly string[] {
  const refs = new Set<string>();
  for (const marker of hypothesis.setupMarkerCandidates) {
    refs.add(marker.documentRef);
  }
  for (const marker of hypothesis.payoffMarkerCandidates) {
    refs.add(marker.documentRef);
  }
  return [...refs];
}
