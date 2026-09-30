import {
  createNarrativeChangeEvent,
  type NarrativeChangeEvent,
} from "@/features/narrative-extraction/maintenance/changeEvent";

export interface FilterExternalChangeEventsOptions {
  readonly projectId: string;
  readonly applicationId: string;
  readonly committedThroughCanonicalSequence: number;
}

/**
 * Exclude an application's own Native transaction from freshness planning.
 * Undo and redo transactions retain the original application ids, so the
 * same guard applies to all three cause directions.
 */
export function filterExternalChangeEvents(
  events: readonly NarrativeChangeEvent[],
  options: FilterExternalChangeEventsOptions,
): readonly NarrativeChangeEvent[] {
  if (options.projectId.trim().length === 0) {
    throw new TypeError("projectId is required");
  }
  if (options.applicationId.trim().length === 0) {
    throw new TypeError("applicationId is required");
  }
  if (
    !Number.isSafeInteger(options.committedThroughCanonicalSequence) ||
    options.committedThroughCanonicalSequence < 0
  ) {
    throw new RangeError(
      "committedThroughCanonicalSequence must be a non-negative safe integer",
    );
  }

  for (const event of events) {
    createNarrativeChangeEvent(event);
    if (event.projectId !== options.projectId) {
      throw new TypeError(
        `event '${event.eventId}' belongs to another project`,
      );
    }
  }

  return events
    .filter(
      (event) =>
        event.canonicalSequence > options.committedThroughCanonicalSequence &&
        !event.cause.applicationIds.includes(options.applicationId),
    )
    .slice()
    .sort(
      (left, right) =>
        left.canonicalSequence - right.canonicalSequence ||
        left.eventOrdinal - right.eventOrdinal ||
        left.eventId.localeCompare(right.eventId),
    );
}
