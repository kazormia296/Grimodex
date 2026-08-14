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
    ).toThrow("changedPaths must contain at least one path");
  });

  it("requires canonical JSON Pointer paths", () => {
    expect(() =>
      createNarrativeChangeEvent(event({ changedPaths: ["title"] })),
    ).toThrow("canonical JSON Pointer");
    expect(() =>
      createNarrativeChangeEvent(event({ changedPaths: ["/title~2"] })),
    ).toThrow("canonical JSON Pointer");
    expect(() =>
      createNarrativeChangeEvent(event({ changedPaths: ["/title~0"] })),
    ).not.toThrow();
  });

  it("seals TextChangeImpact with its UTF-16 normalizer version", () => {
    const valid = {
      unit: "utf16" as const,
      normalizerVersion: "gdx-canonical-text/1",
      oldStorageDigest: "sha256:storage-a" as const,
      newStorageDigest: "sha256:storage-b" as const,
      oldCanonicalDigest: "sha256:canonical-a" as const,
      newCanonicalDigest: "sha256:canonical-b" as const,
      mapping: {
        kind: "canonical-diff" as const,
        changedOldRanges: [{ from: 0, to: 1 }],
        changedNewRanges: [{ from: 0, to: 2 }],
      },
    };
    expect(() =>
      createNarrativeChangeEvent(event({ textImpact: valid })),
    ).not.toThrow();
    expect(() =>
      createNarrativeChangeEvent(
        event({ textImpact: { ...valid, unit: "code-point" as never } }),
      ),
    ).toThrow("textImpact.unit");
  });

  it("accepts epoch markers without pretending they are row-level paths", () => {
    expect(() =>
      createNarrativeChangeEvent(
        event({
          objectKey: { kind: "project", projectId: "project-1" },
          changeKind: "schema",
          structuralImpact: {
            event: "project-restored",
            requiresFullRebuild: true,
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      createNarrativeChangeEvent(
        event({
          structuralImpact: {
            event: "unknown" as never,
          },
        }),
      ),
    ).toThrow("structuralImpact.event");
  });
});
