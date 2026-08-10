import type { DomainObjectKey } from "./domainObjectKey";
import type { Utf16Range } from "./rangeImpact";

/**
 * Plain hex-encoded sha256 digest. Narrative Maintenance compares digests by
 * value and does not require the branded `sha256:` prefix type.
 */
export type Sha256Digest = string;

/**
 * What/who produced a change event. Domain Mutation と同じ Transaction で
 * 確定した Change Feed の正本原因。
 */
export type NarrativeChangeCause =
  | {
      readonly kind: "user-edit";
      readonly surface: string;
    }
  | {
      readonly kind: "narrative-commit";
      readonly commitId: string;
      readonly applicationIds: readonly string[];
      readonly projectionId?: string;
      readonly derivationDigest?: Sha256Digest;
    }
  | {
      readonly kind: "import-commit";
      readonly importSessionId: string;
      readonly commitId: string;
    }
  | {
      readonly kind: "undo";
      readonly originalTransactionId: string;
    }
  | {
      readonly kind: "redo";
      readonly originalTransactionId: string;
    }
  | {
      readonly kind: "sync";
      readonly source: string;
    }
  | {
      readonly kind: "migration";
      readonly migrationId: string;
    }
  | {
      readonly kind: "external";
    };

/** Snapshot of one domain object's identity/content at a point in time. */
export interface ChangeObjectState {
  readonly version: number | null;
  readonly digest: Sha256Digest | null;
}

export type TextRevisionSegmentBehavior =
  | "unchanged"
  | "inserted"
  | "deleted"
  | "replaced";

/**
 * One segment of an old-range -> new-range text revision map, used to
 * reanchor evidence deterministically (see `rangeImpact.ts`).
 */
export interface TextRevisionMapSegment {
  readonly oldRange: Utf16Range;
  readonly newRange: Utf16Range;
  readonly behavior: TextRevisionSegmentBehavior;
}

export interface TextChangeImpact {
  readonly oldStorageDigest: Sha256Digest;
  readonly newStorageDigest: Sha256Digest;
  readonly oldCanonicalDigest: Sha256Digest;
  readonly newCanonicalDigest: Sha256Digest;
  readonly mapping:
    | {
        readonly kind: "position-map";
        readonly segments: readonly TextRevisionMapSegment[];
      }
    | {
        readonly kind: "canonical-diff";
        readonly changedOldRanges: readonly Utf16Range[];
        readonly changedNewRanges: readonly Utf16Range[];
      }
    | {
        readonly kind: "whole-document";
        readonly reason: string;
      };
}

/** Minimal structural impact: which JSON-pointer-ish paths changed. */
export interface StructuralChangeImpact {
  readonly changedPaths: readonly string[];
}

/** One entry in a project's Narrative Maintenance change feed. */
export interface NarrativeChangeEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly projectId: string;
  /** Project 内 Transaction Sequence（同一 Transaction 内の Event は同じ）。 */
  readonly projectSequence: number;
  /** 同一 Transaction 内の安定順序。 */
  readonly eventOrdinal: number;
  readonly transactionId: string;
  readonly objectKey: DomainObjectKey;
  readonly changeKind:
    | "create"
    | "delete"
    | "content"
    | "metadata"
    | "order"
    | "association"
    | "catalog"
    | "calendar"
    | "policy"
    | "schema"
    | "unknown";
  readonly before: ChangeObjectState | null;
  readonly after: ChangeObjectState | null;
  readonly changedPaths: readonly string[];
  readonly textImpact: TextChangeImpact | null;
  readonly structuralImpact: StructuralChangeImpact | null;
  readonly cause: NarrativeChangeCause;
  readonly occurredAt: string;

  /**
   * Compatibility alias used by early ChangeSet coalescers.
   * Prefer `projectSequence` + `eventOrdinal`.
   */
  readonly sequence: number;
  /** Compatibility alias for `eventId`. */
  readonly id: string;
  /** Compatibility alias for `occurredAt`. */
  readonly timestamp: string;
  /** Compatibility alias for text/structural impact. */
  readonly impact: TextChangeImpact | StructuralChangeImpact | null;
}

export interface NarrativeSnapshotSequence {
  readonly projectId: string;
  readonly capturedThroughSequence: number;
}

/** Cheap pointer to "where the change feed currently ends" for one project. */
export interface NarrativeChangeFeedHead {
  readonly projectId: string;
  readonly latestSequence: number;
}

/** Build a feed event with compatibility aliases filled in. */
export function createNarrativeChangeEvent(
  input: Omit<
    NarrativeChangeEvent,
    "sequence" | "id" | "timestamp" | "impact"
  > &
    Partial<
      Pick<NarrativeChangeEvent, "sequence" | "id" | "timestamp" | "impact">
    >,
): NarrativeChangeEvent {
  const textImpact = input.textImpact;
  const structuralImpact = input.structuralImpact;
  return {
    ...input,
    id: input.id ?? input.eventId,
    sequence: input.sequence ?? input.projectSequence,
    timestamp: input.timestamp ?? input.occurredAt,
    impact:
      input.impact ??
      textImpact ??
      structuralImpact ??
      null,
  };
}
