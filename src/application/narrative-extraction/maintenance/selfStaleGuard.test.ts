import { describe, expect, it } from "vitest";

import {
  createNarrativeChangeEvent,
  type NarrativeChangeEvent,
} from "@/features/narrative-extraction/maintenance/changeEvent";
import { filterExternalChangeEvents } from "./selfStaleGuard";

function makeEvent(
  overrides: Partial<NarrativeChangeEvent> & {
    canonicalSequence: number;
    eventId: string;
  },
): NarrativeChangeEvent {
  const { canonicalSequence, eventId, ...rest } = overrides;
  return createNarrativeChangeEvent({
    schemaVersion: 1,
    eventId,
    projectId: "project-1",
    canonicalSequence,
    eventOrdinal: 0,
    transactionId: `tx-${canonicalSequence}`,
    canonicalChangeEventUid: `canonical-${canonicalSequence}`,
    objectKey: { kind: "scene", sceneId: "scene-1" },
    changeKind: "content",
    mutationKind: "update",
    before: null,
    after: null,
    changedPaths: ["/"],
    textImpact: null,
    structuralImpact: null,
    cause: {
      kind: "forward",
      originalTransactionId: null,
      commitId: null,
      journalId: null,
      applicationIds: [],
    },
    occurredAt: "2026-01-01T00:00:00.000Z",
    ...rest,
  });
}

const options = {
  projectId: "project-1",
  applicationId: "application-1",
  committedThroughCanonicalSequence: 0,
} as const;

describe("filterExternalChangeEvents", () => {
  it("filters the application's own forward, undo, and redo transactions", () => {
    const ownCauseBase = {
      originalTransactionId: "original-tx",
      commitId: "commit-1",
      journalId: "journal-1",
      applicationIds: ["application-1"],
    } as const;
    const events = [
      makeEvent({
        eventId: "forward",
        canonicalSequence: 1,
        cause: {
          ...ownCauseBase,
          kind: "forward",
          originalTransactionId: null,
        },
      }),
      makeEvent({
        eventId: "undo",
        canonicalSequence: 2,
        cause: { ...ownCauseBase, kind: "undo" },
      }),
      makeEvent({
        eventId: "redo",
        canonicalSequence: 3,
        cause: { ...ownCauseBase, kind: "redo" },
      }),
      makeEvent({ eventId: "external", canonicalSequence: 4 }),
    ];

    expect(
      filterExternalChangeEvents(events, options).map((event) => event.eventId),
    ).toEqual(["external"]);
  });

  it("filters complete canonical sequences at or before the cursor", () => {
    const events = [
      makeEvent({ eventId: "new", canonicalSequence: 11 }),
      makeEvent({ eventId: "old", canonicalSequence: 5 }),
      makeEvent({ eventId: "at-cursor", canonicalSequence: 10 }),
    ];

    expect(
      filterExternalChangeEvents(events, {
        ...options,
        committedThroughCanonicalSequence: 10,
      }).map((event) => event.eventId),
    ).toEqual(["new"]);
  });

  it("rejects a cross-project batch instead of leaking foreign events", () => {
    expect(() =>
      filterExternalChangeEvents(
        [
          makeEvent({
            eventId: "foreign",
            canonicalSequence: 1,
            projectId: "project-2",
          }),
        ],
        options,
      ),
    ).toThrow("belongs to another project");
  });
});
