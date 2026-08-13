import type {
  Sha256Digest,
  Utf16Range,
} from "@/features/narrative-extraction/source/types";

import {
  assertValidDomainObjectKey,
  type DomainObjectKey,
} from "./domainObjectKey";
import { canonicalChangedPaths } from "./changedPath";
import { assertValidUtf16Range } from "./rangeImpact";

export type { Sha256Digest, Utf16Range };

export type NarrativeChangeCause =
  | {
      readonly kind: "forward";
      readonly originalTransactionId: null;
      readonly commitId: string | null;
      readonly journalId: string | null;
      readonly applicationIds: readonly string[];
    }
  | {
      readonly kind: "undo" | "redo";
      readonly originalTransactionId: string;
      readonly commitId: string | null;
      readonly journalId: string | null;
      readonly applicationIds: readonly string[];
    };

/** Identity and idempotency boundary for one Native-owned feed append. */
export interface NarrativeChangeTransaction {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly sourceDomain: string;
  readonly canonicalChangeEventUid: string;
  readonly canonicalSequence: number;
  readonly cause: NarrativeChangeCause;
  readonly payloadDigest: Sha256Digest;
  readonly occurredAt: string;
}

export interface ChangeObjectState {
  readonly version: number | null;
  readonly digest: Sha256Digest | null;
}

export type TextRevisionSegmentBehavior =
  | "unchanged"
  | "inserted"
  | "deleted"
  | "replaced";

export interface TextRevisionMapSegment {
  readonly oldRange: Utf16Range;
  readonly newRange: Utf16Range;
  readonly behavior: TextRevisionSegmentBehavior;
}

export interface TextChangeImpact {
  readonly unit: "utf16";
  /** Version of the Canonical Text coordinate system used by all ranges. */
  readonly normalizerVersion: string;
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

export interface StructuralChangeImpact {
  readonly changedPaths?: readonly string[];
  /** A bounded semantic epoch marker; it is not a row-level audit diff. */
  readonly event?:
    | "semantic-epoch-reset"
    | "project-restored"
    | "schema-component-changed";
  readonly requiresFullRebuild?: boolean;
}

export type NarrativeChangeKind =
  | "content"
  | "metadata"
  | "order"
  | "association"
  | "catalog"
  | "calendar"
  | "policy"
  | "schema"
  | "unknown";

/**
 * Mutation semantics are independent from the transaction direction. For
 * example, undoing a create is `cause.kind === "undo"` + `mutationKind ===
 * "delete"`, while redoing it is `"redo"` + `"restore"`.
 */
export type NarrativeMutationKind = "create" | "update" | "delete" | "restore";

/** One project-scoped entry derived from the canonical Change Event ledger. */
export interface NarrativeChangeEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly projectId: string;
  readonly transactionId: string;
  readonly canonicalChangeEventUid: string;
  readonly canonicalSequence: number;
  readonly eventOrdinal: number;
  readonly objectKey: DomainObjectKey;
  readonly changeKind: NarrativeChangeKind;
  readonly mutationKind: NarrativeMutationKind;
  readonly before: ChangeObjectState | null;
  readonly after: ChangeObjectState | null;
  readonly changedPaths: readonly string[];
  readonly textImpact: TextChangeImpact | null;
  readonly structuralImpact: StructuralChangeImpact | null;
  readonly cause: NarrativeChangeCause;
  readonly occurredAt: string;
}

export interface NarrativeSnapshotSequence {
  readonly projectId: string;
  readonly capturedThroughCanonicalSequence: number;
}

export interface NarrativeChangeFeedHead {
  readonly projectId: string;
  readonly latestCanonicalSequence: number;
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} is required`);
  }
}

function requireSequence(value: number, field: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${field} must be a safe integer >= ${minimum}`);
  }
}

function requireDigest(value: string, field: string): void {
  if (!value.startsWith("sha256:") || value.length <= "sha256:".length) {
    throw new TypeError(`${field} must be a sha256-prefixed digest`);
  }
}

function validateTextImpact(impact: TextChangeImpact): void {
  if (impact.unit !== "utf16") {
    throw new TypeError("textImpact.unit must be 'utf16'");
  }
  requireNonEmpty(impact.normalizerVersion, "textImpact.normalizerVersion");
  requireDigest(impact.oldStorageDigest, "textImpact.oldStorageDigest");
  requireDigest(impact.newStorageDigest, "textImpact.newStorageDigest");
  requireDigest(impact.oldCanonicalDigest, "textImpact.oldCanonicalDigest");
  requireDigest(impact.newCanonicalDigest, "textImpact.newCanonicalDigest");
  if (impact.mapping.kind === "position-map") {
    for (const [index, segment] of impact.mapping.segments.entries()) {
      assertValidUtf16Range(
        segment.oldRange,
        `textImpact.mapping.segments[${index}].oldRange`,
      );
      assertValidUtf16Range(
        segment.newRange,
        `textImpact.mapping.segments[${index}].newRange`,
      );
      if (
        !["unchanged", "inserted", "deleted", "replaced"].includes(
          segment.behavior,
        )
      ) {
        throw new TypeError(
          "textImpact mapping has an unsupported segment behavior",
        );
      }
    }
  } else if (impact.mapping.kind === "canonical-diff") {
    impact.mapping.changedOldRanges.forEach((range, index) =>
      assertValidUtf16Range(
        range,
        `textImpact.mapping.changedOldRanges[${index}]`,
      ),
    );
    impact.mapping.changedNewRanges.forEach((range, index) =>
      assertValidUtf16Range(
        range,
        `textImpact.mapping.changedNewRanges[${index}]`,
      ),
    );
  } else if (impact.mapping.kind === "whole-document") {
    requireNonEmpty(impact.mapping.reason, "textImpact.mapping.reason");
  } else {
    throw new TypeError("textImpact.mapping.kind is unsupported");
  }
}

function validateStructuralImpact(impact: StructuralChangeImpact): void {
  if (impact.changedPaths) canonicalChangedPaths(impact.changedPaths);
  if (
    impact.event !== undefined &&
    ![
      "semantic-epoch-reset",
      "project-restored",
      "schema-component-changed",
    ].includes(impact.event)
  ) {
    throw new TypeError("structuralImpact.event is unsupported");
  }
  if (impact.event !== undefined && impact.requiresFullRebuild !== true) {
    throw new TypeError(
      "structuralImpact epoch markers require requiresFullRebuild=true",
    );
  }
  if (
    impact.requiresFullRebuild !== undefined &&
    typeof impact.requiresFullRebuild !== "boolean"
  ) {
    throw new TypeError("structuralImpact.requiresFullRebuild must be boolean");
  }
}

/** Validate a decoded Native record before using it for coalescing/planning. */
export function createNarrativeChangeEvent(
  event: NarrativeChangeEvent,
): NarrativeChangeEvent {
  if (event.schemaVersion !== 1) {
    throw new TypeError("unsupported NarrativeChangeEvent schemaVersion");
  }
  requireNonEmpty(event.eventId, "eventId");
  requireNonEmpty(event.projectId, "projectId");
  requireNonEmpty(event.transactionId, "transactionId");
  requireNonEmpty(event.canonicalChangeEventUid, "canonicalChangeEventUid");
  requireNonEmpty(event.occurredAt, "occurredAt");
  requireSequence(event.canonicalSequence, "canonicalSequence", 1);
  requireSequence(event.eventOrdinal, "eventOrdinal", 0);
  assertValidDomainObjectKey(event.objectKey);

  canonicalChangedPaths(event.changedPaths);
  if (event.textImpact) validateTextImpact(event.textImpact);
  if (event.structuralImpact) validateStructuralImpact(event.structuralImpact);
  if (
    event.cause.applicationIds.some((id) => id.trim().length === 0) ||
    new Set(event.cause.applicationIds).size !==
      event.cause.applicationIds.length
  ) {
    throw new TypeError("applicationIds must be unique, non-empty ids");
  }
  if (event.cause.kind === "forward") {
    if (event.cause.originalTransactionId !== null) {
      throw new TypeError(
        "forward events must not name an originalTransactionId",
      );
    }
  } else {
    requireNonEmpty(event.cause.originalTransactionId, "originalTransactionId");
  }

  return event;
}
