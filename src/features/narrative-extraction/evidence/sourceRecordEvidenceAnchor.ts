import type { ResolvedEvidenceAnchor } from "./types";
import type { ImportSourceRecordBase } from "@/features/import/core/importSourceRecord";

/**
 * Evidence anchored to an import source record rather than a narrative corpus view.
 * Non-breaking extension alongside ResolvedEvidenceAnchor consumers.
 */
export interface SourceRecordEvidenceAnchor {
  readonly kind: "source-record";
  readonly recordId: ImportSourceRecordBase["id"];
  readonly recordKind: ImportSourceRecordBase["kind"];
  readonly sourceKey?: string;
  readonly quote: string;
  readonly origin: ImportSourceRecordBase["origin"];
}

export type NarrativeEvidenceAnchor =
  | { readonly kind: "corpus"; readonly anchor: ResolvedEvidenceAnchor }
  | SourceRecordEvidenceAnchor;

export function isSourceRecordEvidenceAnchor(
  anchor: NarrativeEvidenceAnchor,
): anchor is SourceRecordEvidenceAnchor {
  return anchor.kind === "source-record";
}

export function isCorpusEvidenceAnchor(
  anchor: NarrativeEvidenceAnchor,
): anchor is {
  readonly kind: "corpus";
  readonly anchor: ResolvedEvidenceAnchor;
} {
  return anchor.kind === "corpus";
}
