import { describe, expect, it } from "vitest";

import {
  createNarrativeChangeEvent,
  type NarrativeChangeEvent,
} from "./changeEvent";
import { buildChangeSetFromEvents } from "./changeSet";
import { classifyRangeImpact } from "./freshness";

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

function build(events: readonly NarrativeChangeEvent[]) {
  return buildChangeSetFromEvents({
    projectId: "project-1",
    events,
    fromExclusiveCanonicalSequence: 0,
    throughInclusiveCanonicalSequence: 2,
  });
}

describe("buildChangeSetFromEvents", () => {
  it("coalesces A -> B -> C while keeping canonical event order", async () => {
    const stateA = { digest: "sha256:aaa" as const, version: 1 };
    const stateB = { digest: "sha256:bbb" as const, version: 2 };
    const stateC = { digest: "sha256:ccc" as const, version: 3 };
    const changeSet = await build([
      makeEvent({
        eventId: "ev-2",
        canonicalSequence: 2,
        before: stateB,
        after: stateC,
        changedPaths: ["/title"],
      }),
      makeEvent({
        eventId: "ev-1",
        canonicalSequence: 1,
        before: stateA,
        after: stateB,
        changedPaths: ["/body"],
      }),
    ]);

    expect(changeSet.projectId).toBe("project-1");
    expect(changeSet.eventIds).toEqual(["ev-1", "ev-2"]);
    expect(changeSet.objectChanges).toHaveLength(1);
    expect(changeSet.objectChanges[0]).toMatchObject({
      before: stateA,
      after: stateC,
      changedPaths: ["/body", "/title"],
      eventIds: ["ev-1", "ev-2"],
    });
  });

  it("orders events with the same canonical sequence by ordinal", async () => {
    const changeSet = await build([
      makeEvent({
        eventId: "ev-1b",
        canonicalSequence: 1,
        eventOrdinal: 1,
        objectKey: { kind: "scene", sceneId: "scene-b" },
      }),
      makeEvent({
        eventId: "ev-1a",
        canonicalSequence: 1,
        eventOrdinal: 0,
        objectKey: { kind: "scene", sceneId: "scene-a" },
      }),
    ]);

    expect(changeSet.eventIds).toEqual(["ev-1a", "ev-1b"]);
  });

  it("produces the same digest regardless of input order", async () => {
    const first = makeEvent({ eventId: "ev-1", canonicalSequence: 1 });
    const second = makeEvent({ eventId: "ev-2", canonicalSequence: 2 });

    expect((await build([second, first])).digest).toBe(
      (await build([first, second])).digest,
    );
  });

  it("keeps a pure deletion in the pre-change coordinate space", async () => {
    const changeSet = await build([
      makeEvent({
        eventId: "delete-text",
        canonicalSequence: 1,
        before: { version: 1, digest: "sha256:state-a" },
        after: { version: 2, digest: "sha256:state-b" },
        textImpact: {
          unit: "utf16",
          normalizerVersion: "gdx-canonical-text/1",
          oldStorageDigest: "sha256:storage-a",
          newStorageDigest: "sha256:storage-b",
          oldCanonicalDigest: "sha256:canonical-a",
          newCanonicalDigest: "sha256:canonical-b",
          mapping: {
            kind: "canonical-diff",
            changedOldRanges: [{ from: 10, to: 16 }],
            changedNewRanges: [{ from: 10, to: 10 }],
          },
        },
      }),
    ]);

    expect(changeSet.objectChanges[0].rangeImpacts).toEqual([
      {
        eventId: "delete-text",
        normalizerVersion: "gdx-canonical-text/1",
        oldCanonicalDigest: "sha256:canonical-a",
        newCanonicalDigest: "sha256:canonical-b",
        scope: "ranges",
        changedOldRanges: [{ from: 10, to: 16 }],
      },
    ]);
    expect(
      classifyRangeImpact({
        evidenceRange: { from: 11, to: 15 },
        contextRange: { from: 0, to: 20 },
        changedOldRanges:
          changeSet.objectChanges[0].rangeImpacts[0].changedOldRanges,
      }),
    ).toBe("content-stale");
  });

  it("keeps sequential revisions in separate declared coordinate spaces", async () => {
    const stateA = { version: 1, digest: "sha256:state-a" as const };
    const stateB = { version: 2, digest: "sha256:state-b" as const };
    const stateC = { version: 3, digest: "sha256:state-c" as const };
    const changeSet = await build([
      makeEvent({
        eventId: "first-revision",
        canonicalSequence: 1,
        before: stateA,
        after: stateB,
        textImpact: {
          unit: "utf16",
          normalizerVersion: "gdx-canonical-text/1",
          oldStorageDigest: "sha256:storage-a",
          newStorageDigest: "sha256:storage-b",
          oldCanonicalDigest: "sha256:canonical-a",
          newCanonicalDigest: "sha256:canonical-b",
          mapping: {
            kind: "position-map",
            segments: [
              {
                oldRange: { from: 5, to: 5 },
                newRange: { from: 5, to: 10 },
                behavior: "inserted",
              },
              {
                oldRange: { from: 10, to: 12 },
                newRange: { from: 15, to: 17 },
                behavior: "unchanged",
              },
            ],
          },
        },
      }),
      makeEvent({
        eventId: "second-revision",
        canonicalSequence: 2,
        before: stateB,
        after: stateC,
        textImpact: {
          unit: "utf16",
          normalizerVersion: "gdx-canonical-text/1",
          oldStorageDigest: "sha256:storage-b",
          newStorageDigest: "sha256:storage-c",
          oldCanonicalDigest: "sha256:canonical-b",
          newCanonicalDigest: "sha256:canonical-c",
          mapping: {
            kind: "position-map",
            segments: [
              {
                oldRange: { from: 12, to: 12 },
                newRange: { from: 12, to: 15 },
                behavior: "inserted",
              },
              {
                oldRange: { from: 15, to: 17 },
                newRange: { from: 18, to: 20 },
                behavior: "unchanged",
              },
            ],
          },
        },
      }),
    ]);

    expect(changeSet.objectChanges[0].rangeImpacts).toEqual([
      expect.objectContaining({
        eventId: "first-revision",
        oldCanonicalDigest: "sha256:canonical-a",
        changedOldRanges: [{ from: 5, to: 5 }],
      }),
      expect.objectContaining({
        eventId: "second-revision",
        oldCanonicalDigest: "sha256:canonical-b",
        changedOldRanges: [{ from: 12, to: 12 }],
      }),
    ]);
  });

  it("rejects events from another project", async () => {
    await expect(
      build([
        makeEvent({
          eventId: "foreign",
          canonicalSequence: 1,
          projectId: "project-2",
        }),
      ]),
    ).rejects.toThrow("belongs to another project");
  });

  it("rejects duplicate canonical sequence + ordinal coordinates", async () => {
    await expect(
      build([
        makeEvent({ eventId: "ev-a", canonicalSequence: 1 }),
        makeEvent({ eventId: "ev-b", canonicalSequence: 1 }),
      ]),
    ).rejects.toThrow("duplicate canonical feed coordinate 1:0");
  });

  it("rejects split transactions and discontinuous object state", async () => {
    await expect(
      build([
        makeEvent({ eventId: "ev-a", canonicalSequence: 1 }),
        makeEvent({
          eventId: "ev-b",
          canonicalSequence: 1,
          eventOrdinal: 1,
          transactionId: "another-transaction",
        }),
      ]),
    ).rejects.toThrow("spans multiple transactions");

    await expect(
      build([
        makeEvent({
          eventId: "ev-a",
          canonicalSequence: 1,
          after: { version: 2, digest: "sha256:a" },
        }),
        makeEvent({
          eventId: "ev-b",
          canonicalSequence: 2,
          before: { version: 9, digest: "sha256:b" },
        }),
      ]),
    ).rejects.toThrow("discontinuous change history");
  });

  it("rejects an empty canonical interval that cannot be persisted", async () => {
    await expect(
      buildChangeSetFromEvents({
        projectId: "project-1",
        events: [],
        fromExclusiveCanonicalSequence: 2,
        throughInclusiveCanonicalSequence: 2,
      }),
    ).rejects.toThrow(
      "throughInclusiveCanonicalSequence must follow fromExclusiveCanonicalSequence",
    );
  });
});
