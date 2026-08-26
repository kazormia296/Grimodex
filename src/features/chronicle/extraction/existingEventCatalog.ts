import type { EventRow } from "../api";
import type { ExistingChronicleEventCatalogRecord } from "./existingEventMatcher";

export const CHRONICLE_EXISTING_EVENTS_CATALOG_KIND =
  "chronicle.existing-events-catalog@1" as const;

type LiveChronicleEventCatalogSource = Pick<
  EventRow,
  "id" | "title" | "note" | "version" | "startTime" | "endTime"
>;

/**
 * Canonical fresh-start projection of the live Chronicle Event authority.
 * Input order is significant and comes from `listEvents` (`ordinal`, then
 * `id`). Native resume validation mirrors this exact shape and ordering.
 */
export function buildLiveChronicleExistingEventCatalog(
  events: readonly LiveChronicleEventCatalogSource[],
): readonly ExistingChronicleEventCatalogRecord[] {
  return events.map((event) => ({
    ref: event.id,
    sourceKey: event.id,
    title: event.title,
    note: event.note ?? null,
    version: event.version,
    linkedDocumentSourceKeys: [],
    participantEntityRefs: [],
    startTime: event.startTime,
    endTime: event.endTime,
    digest: `sha256:${event.id}`,
    applicationProvenanceKeys: [],
  }));
}

export function buildLiveChronicleExistingEventCatalogEnvelope(
  events: readonly LiveChronicleEventCatalogSource[],
) {
  return {
    kind: CHRONICLE_EXISTING_EVENTS_CATALOG_KIND,
    events: buildLiveChronicleExistingEventCatalog(events),
  } as const;
}
