export const CANONICAL_TEXT_NORMALIZER_VERSION =
  "gdx-canonical-text/1" as const;

export type Sha256Digest = `sha256:${string}`;

export interface CanonicalRange {
  readonly start: number;
  readonly end: number;
}

export interface Utf16Range {
  readonly from: number;
  readonly to: number;
}

export interface CanonicalBlockSpan {
  readonly id: string;
  readonly nodeType: string;
  readonly range: Utf16Range;
  readonly depth: number;
  readonly attrs?: Readonly<Record<string, string | number | boolean | null>>;
}

export type TextProjectionFragmentKind = "linear" | "transformed" | "atomic";

export interface TextProjectionFragment {
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly from: number;
  readonly to: number;
  readonly kind: TextProjectionFragmentKind;
}

export interface MappedProjectionSegment extends TextProjectionFragment {
  readonly canonical: Utf16Range;
  readonly source: {
    readonly kind: "prosemirror";
    readonly fromPos: number;
    readonly toPos: number;
  };
  readonly transform?: "crlf-to-lf" | "cr-to-lf";
  readonly nodeType?: string;
}

export interface SyntheticBoundarySegment {
  readonly kind: "synthetic-boundary";
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly canonical: Utf16Range;
  readonly boundary: {
    readonly leftPmPos: number;
    readonly rightPmPos: number;
  };
  readonly reason: "block-boundary";
}

export type ProjectionSegment =
  | MappedProjectionSegment
  | SyntheticBoundarySegment;

/**
 * Persistable Canonical Text -> ProseMirror position mapping.
 *
 * Synthetic block separators deliberately have no segment. Their canonical
 * offsets are therefore represented by gaps between adjacent segments.
 */
export interface TextProjectionMap {
  readonly schemaVersion: 1;
  readonly unit: "utf16";
  readonly canonicalLength: number;
  readonly segments: readonly ProjectionSegment[];
}

export type TextProjectionResult =
  | {
      readonly status: "exact";
      readonly fragments: readonly TextProjectionFragment[];
    }
  | {
      readonly status: "fragmented";
      readonly fragments: readonly TextProjectionFragment[];
      readonly enclosingRange: {
        readonly from: number;
        readonly to: number;
      };
    }
  | {
      readonly status: "unmapped";
      readonly fragments: readonly [];
    };

export interface CanonicalText {
  readonly unit: "utf16";
  readonly text: string;
  readonly blocks: readonly CanonicalBlockSpan[];
  readonly projection: TextProjectionMap;
  /** Compatibility alias for early PR1 consumers. */
  readonly projectionMap: TextProjectionMap;
  readonly diagnostics: readonly CanonicalTextDiagnostic[];
}

export interface CanonicalTextDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly nodeType?: string;
}

export type CanonicalTextSerializationResult =
  | {
      readonly ok: true;
      readonly canonical: CanonicalText;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly CanonicalTextDiagnostic[];
      readonly partial?: CanonicalText;
    };

export interface GrimodexProjectCorpusOrigin {
  readonly kind: "grimodex-project";
  readonly projectId: string;
}

export type NarrativeCorpusOrigin = GrimodexProjectCorpusOrigin;

export interface ProjectNodeNarrativeOrigin {
  readonly kind: "project-node";
  readonly projectId: string;
  readonly nodeId: string;
  /** Content-generation token; Apply must also compare sourceUpdatedAt. */
  readonly sourceVersion: number;
  /** Aggregate metadata/body freshness token paired with sourceVersion. */
  readonly sourceUpdatedAt: string;
  readonly sourceUri: string | null;
}

export type NarrativeDocumentOrigin = ProjectNodeNarrativeOrigin;

export interface NarrativeSnapshotDocumentInput {
  readonly sourceKey: string;
  readonly parentSourceKey: string | null;
  readonly title: string;
  readonly orderIndex: number;
  readonly proseMirrorJson: string;
  readonly origin: NarrativeDocumentOrigin;
}

export interface NarrativeSnapshotOmission {
  readonly sourceKey: string;
  readonly reason: string;
}

export interface NarrativeSnapshotBuildInput {
  readonly snapshotId: string;
  readonly language: string;
  readonly origin: NarrativeCorpusOrigin;
  readonly documents: readonly NarrativeSnapshotDocumentInput[];
  readonly omissions: readonly NarrativeSnapshotOmission[];
  readonly createdAt: string;
}

export interface NarrativeCorpusDocument {
  readonly ref: string;
  readonly sourceKey: string;
  readonly parentRef: string | null;
  readonly title: string;
  readonly orderIndex: number;
  readonly canonical: CanonicalText;
  readonly contentDigest: Sha256Digest;
  readonly documentDigest: Sha256Digest;
  /** Integrity seal for identity, source freshness, and projection metadata. */
  readonly artifactDigest: Sha256Digest;
  readonly origin: NarrativeDocumentOrigin;
}

export interface NarrativeCorpusSnapshot {
  readonly schemaVersion: 1;
  /** Compatibility alias used by persisted artifact envelopes. */
  readonly id: string;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly language: string;
  readonly normalizerVersion: typeof CANONICAL_TEXT_NORMALIZER_VERSION;
  readonly origin: NarrativeCorpusOrigin;
  readonly documents: readonly NarrativeCorpusDocument[];
  readonly omissions: readonly NarrativeSnapshotOmission[];
  readonly digest: Sha256Digest;
  /** Integrity seal; `digest` remains the cross-run semantic cache key. */
  readonly artifactDigest: Sha256Digest;
}

export interface NarrativeSourceView {
  readonly ref: string;
  readonly documentRef: string;
  readonly documentRange: CanonicalRange;
  readonly text: string;
  readonly digest: Sha256Digest;
}

export interface NarrativeSnapshotDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly documentSourceKey?: string;
  readonly path?: string;
  readonly causeCode?: string;
}

export type SnapshotDiagnostic = NarrativeSnapshotDiagnostic;

export type NarrativeSnapshotBuildResult =
  | {
      readonly ok: true;
      readonly snapshot: NarrativeCorpusSnapshot;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly NarrativeSnapshotDiagnostic[];
    };

export interface ProjectNarrativeSourceRow {
  readonly nodeId: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly content: string;
  readonly sortOrder: string;
  readonly orderIndex: number;
  readonly version: number;
  readonly updatedAt: string;
  readonly sourceUri: string | null;
}
