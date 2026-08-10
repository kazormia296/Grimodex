import { describe, expect, it } from "vitest";
import {
  createNarrativeChangeEvent,
  type NarrativeChangeEvent,
} from "@/features/narrative-extraction/maintenance/changeEvent";
import { filterExternalChangeEvents } from "./selfStaleGuard";

function makeEvent(
  overrides: Partial<NarrativeChangeEvent> & {
    sequence: number;
    id: string;
  },
): NarrativeChangeEvent {
  return createNarrativeChangeEvent({
    schemaVersion: 1,
    eventId: overrides.id,
    projectId: "project-1",
    projectSequence: overrides.sequence,
    eventOrdinal: 0,
    transactionId: `tx-${overrides.sequence}`,
    objectKey: { kind: "scene", sceneId: "scene-1" },
    changeKind: "content",
    before: null,
    after: null,
    changedPaths: [],
    textImpact: null,
    structuralImpact: null,
    cause: { kind: "user-edit", surface: "test" },
    occurredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("filterExternalChangeEvents", () => {
  it("filters out the application's own narrative-commit events", () => {
    const events: NarrativeChangeEvent[] = [
      makeEvent({
        id: "own-commit",
        sequence: 10,
        cause: {
          kind: "narrative-commit",
          commitId: "c1",
          applicationIds: ["foreshadow-panel"],
        },
      }),
      makeEvent({
        id: "other-commit",
        sequence: 11,
        cause: {
          kind: "narrative-commit",
          commitId: "c2",
          applicationIds: ["codex-panel"],
        },
      }),
    ];

    const result = filterExternalChangeEvents(events, {
      applicationId: "foreshadow-panel",
      committedAtSequence: 0,
    });

    expect(result.map((event) => event.id)).toEqual(["other-commit"]);
  });

  it("filters out events at or before the consumer's committed sequence", () => {
    const events: NarrativeChangeEvent[] = [
      makeEvent({ id: "old", sequence: 5 }),
      makeEvent({ id: "at-cursor", sequence: 10 }),
      makeEvent({ id: "new", sequence: 11 }),
    ];

    const result = filterExternalChangeEvents(events, {
      applicationId: "foreshadow-panel",
      committedAtSequence: 10,
    });

    expect(result.map((event) => event.id)).toEqual(["new"]);
  });

  it("keeps user-edit events after the cursor", () => {
    const events: NarrativeChangeEvent[] = [
      makeEvent({
        id: "user-edit",
        sequence: 11,
        cause: { kind: "user-edit", surface: "editor" },
      }),
    ];

    const result = filterExternalChangeEvents(events, {
      applicationId: "foreshadow-panel",
      committedAtSequence: 10,
    });

    expect(result.map((event) => event.id)).toEqual(["user-edit"]);
  });
});
