import { digestStableJson } from "../source/digest";
import {
  domainObjectKeyToString,
  type DomainObjectKey,
} from "./domainObjectKey";
import type {
  ChangeObjectState,
  NarrativeChangeEvent,
  Sha256Digest,
} from "./changeEvent";
import type { Utf16Range } from "./rangeImpact";

/** Coalesced view of every change to one object within a `NarrativeChangeSet`. */
export interface NarrativeObjectChangeSummary {
  readonly objectKey: DomainObjectKey;
  readonly before: ChangeObjectState | null;
  readonly after: ChangeObjectState | null;
  readonly changedPaths: readonly string[];
  readonly changedRanges: readonly Utf16Range[];
  readonly eventIds: readonly string[];
}

/**
 * A coalesced, digest-sealed view of `(fromExclusive, throughInclusive]` of a
 * project's Narrative Maintenance change feed. Built by
 * `buildChangeSetFromEvents`; consumers (impact planner, freshness
 * classification) read this instead of replaying raw events.
 */
export interface NarrativeChangeSet {
  readonly schemaVersion: 1;
  readonly fromExclusive: number;
  readonly throughInclusive: number;
  readonly eventIds: readonly string[];
  readonly objectChanges: readonly NarrativeObjectChangeSummary[];
  readonly digest: Sha256Digest;
}

interface MutableObjectChange {
  objectKey: DomainObjectKey;
  before: ChangeObjectState | null;
  after: ChangeObjectState | null;
  changedPaths: Set<string>;
  changedRanges: Utf16Range[];
  eventIds: string[];
  firstSequence: number;
}

function isSameRange(a: Utf16Range, b: Utf16Range): boolean {
  return a.from === b.from && a.to === b.to;
}

function pushUniqueRange(ranges: Utf16Range[], range: Utf16Range): void {
  if (ranges.some((existing) => isSameRange(existing, range))) return;
  ranges.push(range);
}

/**
 * Coalesce a slice of `NarrativeChangeEvent`s into a `NarrativeChangeSet`.
 *
 * Only events with `fromExclusive < sequence <= throughInclusive` are
 * considered. Events for the same object are folded together, keeping the
 * *first* `before` and the *last* `after` seen (in sequence order) so the
 * set represents "what changed overall", not each intermediate step.
 */
export async function buildChangeSetFromEvents(
  events: readonly NarrativeChangeEvent[],
  fromExclusive: number,
  throughInclusive: number,
): Promise<NarrativeChangeSet> {
  const inRange = events
    .filter(
      (event) =>
        event.sequence > fromExclusive && event.sequence <= throughInclusive,
    )
    .slice()
    .sort((a, b) => a.sequence - b.sequence);

  const byObject = new Map<string, MutableObjectChange>();
  const eventIds: string[] = [];

  for (const event of inRange) {
    eventIds.push(event.id);
    const key = domainObjectKeyToString(event.objectKey);
    let entry = byObject.get(key);
    if (!entry) {
      entry = {
        objectKey: event.objectKey,
        before: event.before,
        after: event.after,
        changedPaths: new Set(event.changedPaths),
        changedRanges: [],
        eventIds: [],
        firstSequence: event.sequence,
      };
      byObject.set(key, entry);
    } else {
      entry.after = event.after;
      for (const path of event.changedPaths) entry.changedPaths.add(path);
    }
    entry.eventIds.push(event.id);
    const textImpact = event.textImpact;
    if (textImpact?.mapping.kind === "canonical-diff") {
      for (const range of textImpact.mapping.changedNewRanges) {
        pushUniqueRange(entry.changedRanges, range);
      }
    } else if (textImpact?.mapping.kind === "position-map") {
      for (const segment of textImpact.mapping.segments) {
        if (segment.behavior !== "unchanged") {
          pushUniqueRange(entry.changedRanges, segment.newRange);
        }
      }
    }
  }

  const objectChanges: NarrativeObjectChangeSummary[] = Array.from(
    byObject.values(),
  )
    .sort((a, b) => a.firstSequence - b.firstSequence)
    .map((entry) => ({
      objectKey: entry.objectKey,
      before: entry.before,
      after: entry.after,
      changedPaths: Array.from(entry.changedPaths).sort(),
      changedRanges: entry.changedRanges,
      eventIds: entry.eventIds,
    }));

  const sortedEventIds = Array.from(new Set(eventIds)).sort();

  const digest = await digestStableJson({
    schemaVersion: 1,
    fromExclusive,
    throughInclusive,
    eventIds: sortedEventIds,
    objectChanges: objectChanges.map((change) => ({
      objectKey: change.objectKey,
      before: change.before,
      after: change.after,
      changedPaths: change.changedPaths,
      changedRanges: change.changedRanges,
    })),
  });

  return {
    schemaVersion: 1,
    fromExclusive,
    throughInclusive,
    eventIds: sortedEventIds,
    objectChanges,
    digest,
  };
}
