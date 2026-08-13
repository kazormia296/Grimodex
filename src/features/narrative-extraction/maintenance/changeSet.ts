import { digestStableJson } from "../source/digest";
import {
  createNarrativeChangeEvent,
  type ChangeObjectState,
  type NarrativeChangeEvent,
  type NarrativeMutationKind,
  type Sha256Digest,
  type TextChangeImpact,
} from "./changeEvent";
import {
  domainObjectKeyToString,
  type DomainObjectKey,
} from "./domainObjectKey";
import { assertValidUtf16Range, type Utf16Range } from "./rangeImpact";

export interface NarrativeObjectChangeSummary {
  readonly objectKey: DomainObjectKey;
  readonly before: ChangeObjectState | null;
  readonly after: ChangeObjectState | null;
  readonly mutationKinds: readonly NarrativeMutationKind[];
  readonly changedPaths: readonly string[];
  /**
   * Revision-scoped range impact. Each batch is expressed in the canonical
   * coordinates identified by `oldCanonicalDigest`; ranges from sequential
   * revisions must never be flattened into one coordinate space.
   *
   * Exact reanchor remains a per-event operation: use `eventId` to pair this
   * batch with that event's `textImpact.mapping` and advance one revision at a
   * time.
   */
  readonly rangeImpacts: readonly NarrativeEventRangeImpact[];
  readonly eventIds: readonly string[];
}

export interface NarrativeEventRangeImpact {
  readonly eventId: string;
  readonly oldCanonicalDigest: Sha256Digest;
  readonly newCanonicalDigest: Sha256Digest;
  readonly scope: "ranges" | "whole-document";
  /** Half-open ranges in `oldCanonicalDigest` coordinates. */
  readonly changedOldRanges: readonly Utf16Range[];
}

/** A digest-sealed, project-scoped coalescing of a canonical feed interval. */
export interface NarrativeChangeSet {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly fromExclusiveCanonicalSequence: number;
  readonly throughInclusiveCanonicalSequence: number;
  readonly eventIds: readonly string[];
  readonly objectChanges: readonly NarrativeObjectChangeSummary[];
  readonly digest: Sha256Digest;
}

export interface BuildChangeSetFromEventsInput {
  readonly projectId: string;
  readonly events: readonly NarrativeChangeEvent[];
  readonly fromExclusiveCanonicalSequence: number;
  readonly throughInclusiveCanonicalSequence: number;
}

interface MutableObjectChange {
  objectKey: DomainObjectKey;
  before: ChangeObjectState | null;
  after: ChangeObjectState | null;
  mutationKinds: Set<NarrativeMutationKind>;
  changedPaths: Set<string>;
  rangeImpacts: NarrativeEventRangeImpact[];
  eventIds: string[];
  firstCanonicalSequence: number;
  firstEventOrdinal: number;
  stableObjectKey: string;
}

function requireCursor(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

function pushUniqueRange(ranges: Utf16Range[], range: Utf16Range): void {
  assertValidUtf16Range(range, "changed range");
  if (
    ranges.some(
      (existing) => existing.from === range.from && existing.to === range.to,
    )
  ) {
    return;
  }
  ranges.push(range);
}

function summarizeOldRangeImpact(
  impact: TextChangeImpact,
): Pick<NarrativeEventRangeImpact, "scope" | "changedOldRanges"> {
  const ranges: Utf16Range[] = [];
  if (impact.mapping.kind === "canonical-diff") {
    impact.mapping.changedOldRanges.forEach((range) =>
      pushUniqueRange(ranges, range),
    );
  } else if (impact.mapping.kind === "position-map") {
    impact.mapping.segments.forEach((segment) => {
      if (segment.behavior !== "unchanged") {
        pushUniqueRange(ranges, segment.oldRange);
      }
    });
  } else {
    return { scope: "whole-document", changedOldRanges: [] };
  }
  return {
    scope: "ranges",
    changedOldRanges: ranges.sort(
      (left, right) => left.from - right.from || left.to - right.to,
    ),
  };
}

function compareEvents(
  left: NarrativeChangeEvent,
  right: NarrativeChangeEvent,
): number {
  return (
    left.canonicalSequence - right.canonicalSequence ||
    left.eventOrdinal - right.eventOrdinal ||
    left.eventId.localeCompare(right.eventId)
  );
}

function statesEqual(
  left: ChangeObjectState | null,
  right: ChangeObjectState | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.version === right.version &&
      left.digest === right.digest)
  );
}

export async function buildChangeSetFromEvents(
  input: BuildChangeSetFromEventsInput,
): Promise<NarrativeChangeSet> {
  if (input.projectId.trim().length === 0) {
    throw new TypeError("projectId is required");
  }
  requireCursor(
    input.fromExclusiveCanonicalSequence,
    "fromExclusiveCanonicalSequence",
  );
  requireCursor(
    input.throughInclusiveCanonicalSequence,
    "throughInclusiveCanonicalSequence",
  );
  if (
    input.throughInclusiveCanonicalSequence <=
    input.fromExclusiveCanonicalSequence
  ) {
    throw new RangeError(
      "throughInclusiveCanonicalSequence must follow fromExclusiveCanonicalSequence",
    );
  }

  for (const event of input.events) {
    createNarrativeChangeEvent(event);
    if (event.projectId !== input.projectId) {
      throw new TypeError(
        `event '${event.eventId}' belongs to another project`,
      );
    }
  }

  const inRange = input.events
    .filter(
      (event) =>
        event.canonicalSequence > input.fromExclusiveCanonicalSequence &&
        event.canonicalSequence <= input.throughInclusiveCanonicalSequence,
    )
    .slice()
    .sort(compareEvents);

  const seenCoordinates = new Set<string>();
  const seenEventIds = new Set<string>();
  const transactionBySequence = new Map<
    number,
    {
      transactionId: string;
      canonicalChangeEventUid: string;
      nextOrdinal: number;
    }
  >();
  for (const event of inRange) {
    const coordinate = `${event.canonicalSequence}:${event.eventOrdinal}`;
    if (seenCoordinates.has(coordinate)) {
      throw new TypeError(`duplicate canonical feed coordinate ${coordinate}`);
    }
    if (seenEventIds.has(event.eventId)) {
      throw new TypeError(`duplicate eventId '${event.eventId}'`);
    }
    seenCoordinates.add(coordinate);
    seenEventIds.add(event.eventId);

    const transaction = transactionBySequence.get(event.canonicalSequence);
    if (!transaction) {
      if (event.eventOrdinal !== 0) {
        throw new TypeError(
          `canonical sequence ${event.canonicalSequence} must start at ordinal 0`,
        );
      }
      transactionBySequence.set(event.canonicalSequence, {
        transactionId: event.transactionId,
        canonicalChangeEventUid: event.canonicalChangeEventUid,
        nextOrdinal: 1,
      });
    } else {
      if (
        event.transactionId !== transaction.transactionId ||
        event.canonicalChangeEventUid !== transaction.canonicalChangeEventUid
      ) {
        throw new TypeError(
          `canonical sequence ${event.canonicalSequence} spans multiple transactions`,
        );
      }
      if (event.eventOrdinal !== transaction.nextOrdinal) {
        throw new TypeError(
          `canonical sequence ${event.canonicalSequence} has a non-contiguous ordinal`,
        );
      }
      transaction.nextOrdinal += 1;
    }
  }

  const byObject = new Map<string, MutableObjectChange>();
  for (const event of inRange) {
    const stableObjectKey = domainObjectKeyToString(event.objectKey);
    let entry = byObject.get(stableObjectKey);
    if (!entry) {
      entry = {
        objectKey: event.objectKey,
        before: event.before,
        after: event.after,
        mutationKinds: new Set(),
        changedPaths: new Set(),
        rangeImpacts: [],
        eventIds: [],
        firstCanonicalSequence: event.canonicalSequence,
        firstEventOrdinal: event.eventOrdinal,
        stableObjectKey,
      };
      byObject.set(stableObjectKey, entry);
    } else {
      if (!statesEqual(entry.after, event.before)) {
        throw new TypeError(
          `object '${stableObjectKey}' has a discontinuous change history`,
        );
      }
      entry.after = event.after;
    }

    entry.mutationKinds.add(event.mutationKind);
    event.changedPaths.forEach((path) => entry?.changedPaths.add(path));
    entry.eventIds.push(event.eventId);

    if (event.textImpact) {
      const oldRangeImpact = summarizeOldRangeImpact(event.textImpact);
      entry.rangeImpacts.push({
        eventId: event.eventId,
        oldCanonicalDigest: event.textImpact.oldCanonicalDigest,
        newCanonicalDigest: event.textImpact.newCanonicalDigest,
        ...oldRangeImpact,
      });
    }
  }

  const objectChanges: NarrativeObjectChangeSummary[] = Array.from(
    byObject.values(),
  )
    .sort(
      (left, right) =>
        left.firstCanonicalSequence - right.firstCanonicalSequence ||
        left.firstEventOrdinal - right.firstEventOrdinal ||
        left.stableObjectKey.localeCompare(right.stableObjectKey),
    )
    .map((entry) => ({
      objectKey: entry.objectKey,
      before: entry.before,
      after: entry.after,
      mutationKinds: Array.from(entry.mutationKinds).sort(),
      changedPaths: Array.from(entry.changedPaths).sort(),
      rangeImpacts: entry.rangeImpacts,
      eventIds: entry.eventIds,
    }));

  const eventIds = inRange.map((event) => event.eventId);
  const digest = await digestStableJson({
    schemaVersion: 1,
    projectId: input.projectId,
    fromExclusiveCanonicalSequence: input.fromExclusiveCanonicalSequence,
    throughInclusiveCanonicalSequence: input.throughInclusiveCanonicalSequence,
    eventIds,
    objectChanges,
  });

  return {
    schemaVersion: 1,
    projectId: input.projectId,
    fromExclusiveCanonicalSequence: input.fromExclusiveCanonicalSequence,
    throughInclusiveCanonicalSequence: input.throughInclusiveCanonicalSequence,
    eventIds,
    objectChanges,
    digest,
  };
}
