import type {
  CanonicalRange,
  NarrativeCorpusDocument,
  NarrativeCorpusSnapshot,
  NarrativeSourceView,
  Sha256Digest,
  TextProjectionResult,
} from "../source/types";

/** Untrusted evidence coordinates emitted by an extractor. */
export interface RawEvidenceReference {
  readonly sourceRef: NarrativeSourceView["ref"];
  readonly quote: string;
  readonly prefix?: string;
  readonly suffix?: string;
}

export type EvidenceResolutionMethod = "exact" | "exact-with-context";

export interface EvidenceAnchorContext {
  /** Exact source-view text immediately before the quote. */
  readonly prefix: string;
  /** Exact source-view text immediately after the quote. */
  readonly suffix: string;
}

export type ResolvedEvidenceProjection = Exclude<
  TextProjectionResult,
  { readonly status: "unmapped" }
>;

/** Immutable, digest-bound evidence that can be reviewed and navigated. */
export interface ResolvedEvidenceAnchor {
  readonly id: string;
  readonly sourceRef: NarrativeSourceView["ref"];
  readonly documentRef: NarrativeCorpusDocument["ref"];
  readonly quote: string;
  readonly canonicalRange: CanonicalRange;
  readonly sourceRange: CanonicalRange;
  readonly projection: ResolvedEvidenceProjection;
  readonly context: EvidenceAnchorContext;
  readonly method: EvidenceResolutionMethod;
  readonly initialMatchCount: number;
  readonly quoteDigest: Sha256Digest;
  readonly snapshotDigest: NarrativeCorpusSnapshot["digest"];
  readonly contentDigest: NarrativeCorpusDocument["contentDigest"];
  readonly documentDigest: NarrativeCorpusDocument["documentDigest"];
  readonly documentArtifactDigest: NarrativeCorpusDocument["artifactDigest"];
  readonly sourceDigest: NarrativeSourceView["digest"];
}

export type InvalidEvidenceReason =
  | "invalid-reference"
  | "invalid-options"
  | "empty-source-ref"
  | "empty-quote"
  | "quote-too-long"
  | "invalid-unicode"
  | "unknown-source-ref"
  | "duplicate-source-ref"
  | "unknown-document-ref"
  | "duplicate-document-ref"
  | "invalid-source-view"
  | "source-view-mismatch"
  | "source-view-digest-mismatch"
  | "unmapped-projection";

export type EvidenceResolutionResult =
  | {
      readonly status: "resolved";
      readonly anchor: ResolvedEvidenceAnchor;
    }
  | {
      readonly status: "not-found";
      readonly sourceRef: string;
      readonly quote: string;
    }
  | {
      readonly status: "ambiguous";
      readonly sourceRef: string;
      readonly quote: string;
      readonly initialMatchCount: number;
      readonly remainingMatchCount: number;
    }
  | {
      readonly status: "invalid";
      readonly reason: InvalidEvidenceReason;
      readonly sourceRef?: string;
      readonly quote?: string;
    };

export interface EvidenceResolutionContext {
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly sourceViews: readonly NarrativeSourceView[];
  readonly createAnchorId: () => string;
  readonly contextRadius?: number;
  readonly maxQuoteLength?: number;
}
