import type { NarrativeEntityId } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import type { PhaseBoundaryHypothesis } from "@/features/narrative-extraction/ir/inferences/phaseBoundary";

/** Opaque catalog ref for an existing Codex Phase (never a DB UUID in AI prompts). */
export type KnowledgePhaseRef = string;

export interface ExistingPhaseCatalogRecord {
  readonly ref: KnowledgePhaseRef;
  readonly entityId: NarrativeEntityId;
  readonly anchorDocumentRef: string | null;
  readonly label: string;
  readonly expectedVersion: number;
}

export type ExistingPhaseMatch =
  | { readonly status: "none" }
  | {
      readonly status: "resolved";
      readonly ref: KnowledgePhaseRef;
      readonly method: "exact-anchor" | "exact-label";
      readonly expectedVersion: number;
    }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly {
        readonly ref: KnowledgePhaseRef;
        readonly score: number;
        readonly methods: readonly ("exact-anchor" | "exact-label")[];
      }[];
    };

function normalizeLabel(label: string): string {
  return label.normalize("NFC").trim().toLowerCase();
}

/**
 * Match a Phase Boundary against existing Phase catalog rows.
 * Exact same entity+anchor is preferred; label-only is candidate-grade.
 */
export function matchExistingPhase(
  boundary: PhaseBoundaryHypothesis,
  catalog: readonly ExistingPhaseCatalogRecord[],
): ExistingPhaseMatch {
  const entityId = boundary.payload.entityId;
  const anchor = boundary.payload.anchorDocumentRef;
  const label = boundary.payload.labelSuggestion;

  const sameEntity = catalog.filter((row) => row.entityId === entityId);
  const anchorHits = sameEntity.filter(
    (row) => row.anchorDocumentRef !== null && row.anchorDocumentRef === anchor,
  );

  if (anchorHits.length === 1) {
    return {
      status: "resolved",
      ref: anchorHits[0].ref,
      method: "exact-anchor",
      expectedVersion: anchorHits[0].expectedVersion,
    };
  }
  if (anchorHits.length > 1) {
    return {
      status: "ambiguous",
      candidates: anchorHits.map((row) => ({
        ref: row.ref,
        score: 100,
        methods: ["exact-anchor" as const],
      })),
    };
  }

  if (label) {
    const normalized = normalizeLabel(label);
    const labelHits = sameEntity.filter(
      (row) => normalizeLabel(row.label) === normalized,
    );
    if (labelHits.length === 1) {
      return {
        status: "resolved",
        ref: labelHits[0].ref,
        method: "exact-label",
        expectedVersion: labelHits[0].expectedVersion,
      };
    }
    if (labelHits.length > 1) {
      return {
        status: "ambiguous",
        candidates: labelHits.map((row) => ({
          ref: row.ref,
          score: 80,
          methods: ["exact-label" as const],
        })),
      };
    }
  }

  return { status: "none" };
}
