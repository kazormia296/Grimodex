import { describe, expect, it } from "vitest";

import {
  createNarrativeChangeEvent,
  type NarrativeChangeEvent,
} from "./changeEvent";

function event(
  overrides: Partial<NarrativeChangeEvent> = {},
): NarrativeChangeEvent {
  return {
    schemaVersion: 1,
    eventId: "event-1",
    projectId: "project-1",
    transactionId: "transaction-1",
    canonicalChangeEventUid: "canonical-1",
    canonicalSequence: 1,
    eventOrdinal: 0,
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
    occurredAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("createNarrativeChangeEvent", () => {
  it("rejects an event without an explicit changed path", () => {
    expect(() =>
      createNarrativeChangeEvent(event({ changedPaths: [] })),
    ).toThrow("changedPaths must be unique, non-empty paths");
  });
});
