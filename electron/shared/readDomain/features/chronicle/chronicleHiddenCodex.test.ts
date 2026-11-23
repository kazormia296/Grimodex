import { describe, expect, it } from "vitest";
import type { EventRow } from "./eventRows.js";
import {
  collectChronicleCandidateCodexIds,
  dropHiddenCodexFromChronicleInput,
} from "./chronicleHiddenCodex.js";

function event(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "event-1",
    projectId: "project-1",
    title: "event",
    note: null,
    detail: null,
    ordinal: "a0",
    primaryCodexId: null,
    laneGroup: null,
    locationCodexId: null,
    startTime: null,
    endTime: null,
    startMinute: null,
    endMinute: null,
    startGranularity: "none",
    endGranularity: "none",
    precision: "exact",
    kind: "generic",
    secret: false,
    revealSceneId: null,
    version: 0,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("chronicleHiddenCodex", () => {
  it("collects unique non-empty candidate ids in ascending order", () => {
    expect(
      collectChronicleCandidateCodexIds({
        events: [
          { primaryCodexId: "b", locationCodexId: "a" },
          { primaryCodexId: "b", locationCodexId: null },
        ],
        participants: [{ codexEntryId: "c" }, { codexEntryId: "a" }],
        codexNames: new Map([
          ["d", "D"],
          ["", "empty"],
        ]),
        sceneCodexIds: ["e", "b", null],
        mentionedCodexIds: ["f", "c", ""],
      }),
    ).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("drops hidden people while preserving hidden location ids without mutating input", () => {
    const args = {
      events: [
        event({
          primaryCodexId: "hidden-primary",
          locationCodexId: "hidden-location",
        }),
        event({ id: "visible", primaryCodexId: "visible-person" }),
      ],
      participants: [
        { eventId: "event-1", codexEntryId: "hidden-participant", role: null },
        { eventId: "event-1", codexEntryId: "visible-person", role: null },
      ],
      codexNames: new Map([
        ["hidden-primary", "Hidden Primary"],
        ["hidden-location", "Hidden Location"],
        ["hidden-participant", "Hidden Participant"],
        ["visible-person", "Visible Person"],
      ]),
      sceneCodexIds: ["hidden-scene", "visible-person"],
      mentionedCodexIds: ["hidden-mention", "visible-person"],
    };
    const original = structuredClone({
      ...args,
      codexNames: [...args.codexNames],
    });

    const result = dropHiddenCodexFromChronicleInput(
      args,
      new Set([
        "hidden-primary",
        "hidden-location",
        "hidden-participant",
        "hidden-scene",
        "hidden-mention",
      ]),
    );

    expect(result.events[0]).toMatchObject({
      primaryCodexId: null,
      locationCodexId: "hidden-location",
    });
    expect(result.participants).toEqual([
      { eventId: "event-1", codexEntryId: "visible-person", role: null },
    ]);
    expect([...result.codexNames.keys()]).toEqual(["visible-person"]);
    expect(result.sceneCodexIds).toEqual(["visible-person"]);
    expect(result.mentionedCodexIds).toEqual(["visible-person"]);
    expect({ ...args, codexNames: [...args.codexNames] }).toEqual(original);
  });

  it("keeps the same content when hidden is empty", () => {
    const args = {
      events: [event({ primaryCodexId: "person" })],
      participants: [
        { eventId: "event-1", codexEntryId: "person", role: null },
      ],
      codexNames: new Map([["person", "Person"]]),
      sceneCodexIds: ["person"],
      mentionedCodexIds: ["person"],
    };

    const result = dropHiddenCodexFromChronicleInput(args, new Set());

    expect(result).toEqual(args);
    expect(result).not.toBe(args);
  });
});
