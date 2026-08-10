import type { NarrativeChangeEvent } from "@/features/narrative-extraction/maintenance/changeEvent";

export interface FilterExternalChangeEventsOptions {
  readonly applicationId: string;
  readonly committedAtSequence: number;
}

/**
 * Guard against an application marking its own writes as external changes.
 * Filters:
 * - events at or before the consumer's committed sequence
 * - narrative-commit events that include this applicationId
 */
export function filterExternalChangeEvents(
  events: readonly NarrativeChangeEvent[],
  options: FilterExternalChangeEventsOptions,
): readonly NarrativeChangeEvent[] {
  return events.filter((event) => {
    if (event.sequence <= options.committedAtSequence) return false;
    if (event.cause.kind === "narrative-commit") {
      const ids = event.cause.applicationIds;
      if (ids.includes(options.applicationId)) return false;
    }
    return true;
  });
}
