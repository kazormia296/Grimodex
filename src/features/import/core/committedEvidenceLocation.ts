/**
 * Where committed import evidence can be located after Final Commit.
 * Generic Import allows extract-only resources that never become Scenes.
 */
export type CommittedEvidenceLocation =
  | {
      readonly kind: "project-document";
      readonly nodeId: string;
      readonly nodeType: "scene" | "note";
      readonly storageDigest: string;
      readonly projection: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "retained-import-source";
      readonly importSessionId: string;
      readonly sourceDocumentKey: string;
      readonly retainedDocumentDigest: string;
      readonly canonicalRange: { readonly start: number; readonly end: number };
    }
  | {
      readonly kind: "evidence-only";
      readonly sourceDocumentKey: string;
      readonly quote: string;
      readonly prefix: string;
      readonly suffix: string;
      readonly quoteDigest: string;
    };

export function isProjectDocumentEvidence(
  location: CommittedEvidenceLocation,
): location is Extract<
  CommittedEvidenceLocation,
  { kind: "project-document" }
> {
  return location.kind === "project-document";
}

export function isRetainedImportSourceEvidence(
  location: CommittedEvidenceLocation,
): location is Extract<
  CommittedEvidenceLocation,
  { kind: "retained-import-source" }
> {
  return location.kind === "retained-import-source";
}

export function isEvidenceOnlyLocation(
  location: CommittedEvidenceLocation,
): location is Extract<CommittedEvidenceLocation, { kind: "evidence-only" }> {
  return location.kind === "evidence-only";
}
