import { describe, expect, it } from "vitest";
import {
  createNarrativeChangeEvent,
  type NarrativeChangeEvent,
} from "./changeEvent";
import { buildChangeSetFromEvents } from "./changeSet";

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

describe("buildChangeSetFromEvents", () => {
  it("coalesces A -> B -> C for the same object, keeping first before and last after", async () => {
    const stateA = { digest: "sha256:aaa", version: 1 };
    const stateB = { digest: "sha256:bbb", version: 2 };
    const stateC = { digest: "sha256:ccc", version: 3 };

    const events: NarrativeChangeEvent[] = [
      makeEvent({
        id: "ev-1",
        sequence: 1,
        before: stateA,
        after: stateB,
        changedPaths: ["body"],
      }),
      makeEvent({
        id: "ev-2",
        sequence: 2,
        before: stateB,
        after: stateC,
        changedPaths: ["title"],
      }),
    ];

    const changeSet = await buildChangeSetFromEvents(events, 0, 2);

    expect(changeSet.objectChanges).toHaveLength(1);
    const [summary] = changeSet.objectChanges;
    expect(summary.before).toEqual(stateA);
    expect(summary.after).toEqual(stateC);
    expect(summary.changedPaths).toEqual(["body", "title"]);
    expect(summary.eventIds).toEqual(["ev-1", "ev-2"]);
  });

  it("merges changedPaths uniquely across coalesced events", async () => {
    const events: NarrativeChangeEvent[] = [
      makeEvent({ id: "ev-1", sequence: 1, changedPaths: ["body", "title"] }),
      makeEvent({ id: "ev-2", sequence: 2, changedPaths: ["title", "notes"] }),
    ];

    const changeSet = await buildChangeSetFromEvents(events, 0, 2);
    expect(changeSet.objectChanges[0]?.changedPaths).toEqual([
      "body",
      "notes",
      "title",
    ]);
  });

  it("produces a stable digest for the same event set regardless of input order", async () => {
    const eventsA: NarrativeChangeEvent[] = [
      makeEvent({ id: "ev-2", sequence: 2 }),
      makeEvent({ id: "ev-1", sequence: 1 }),
    ];
    const eventsB: NarrativeChangeEvent[] = [
      makeEvent({ id: "ev-1", sequence: 1 }),
      makeEvent({ id: "ev-2", sequence: 2 }),
    ];

    const a = await buildChangeSetFromEvents(eventsA, 0, 2);
    const b = await buildChangeSetFromEvents(eventsB, 0, 2);
    expect(a.digest).toBe(b.digest);
    expect(a.eventIds).toEqual(["ev-1", "ev-2"]);
  });
});
