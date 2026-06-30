import { describe, it, expect } from "vitest";
import type { EventRow, SceneEventRow } from "./api";
import {
  readingPos,
  effectiveRevealSceneId,
  isEventHiddenFromAi,
  projectVisibleChronicle,
  type ReadingOrder,
} from "./chronicleSecrecy";

function ev(partial: Partial<EventRow> & { id: string }): EventRow {
  return {
    id: partial.id,
    projectId: "p1",
    title: partial.title ?? partial.id,
    note: partial.note ?? null,
    ordinal: partial.ordinal ?? "a0",
    primaryCodexId: partial.primaryCodexId ?? null,
    locationCodexId: partial.locationCodexId ?? null,
    startTime: partial.startTime ?? null,
    endTime: partial.endTime ?? null,
    startMinute: partial.startMinute ?? null,
    endMinute: partial.endMinute ?? null,
    startGranularity: partial.startGranularity ?? "none",
    endGranularity: partial.endGranularity ?? "none",
    precision: partial.precision ?? "exact",
    kind: partial.kind ?? "generic",
    secret: partial.secret ?? false,
    revealSceneId: partial.revealSceneId ?? null,
    laneGroup: partial.laneGroup ?? null,
    createdAt: "",
    updatedAt: "",
  };
}

// reading order: s0 < s1 < s2 < s3 < s4
const ORDER: ReadingOrder = new Map([
  ["s0", 0],
  ["s1", 1],
  ["s2", 2],
  ["s3", 3],
  ["s4", 4],
]);

describe("readingPos", () => {
  it("returns index for known scene, +Infinity for unknown", () => {
    expect(readingPos(ORDER, "s2")).toBe(2);
    expect(readingPos(ORDER, "ghost")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("effectiveRevealSceneId", () => {
  it("explicit override wins over stamps", () => {
    const e = ev({ id: "e1", secret: true, revealSceneId: "s3" });
    const se: SceneEventRow[] = [{ sceneId: "s1", eventId: "e1" }];
    expect(effectiveRevealSceneId(e, se, ORDER)).toBe("s3");
  });

  it("auto-derives the reading-order-min stamped scene (not insert order)", () => {
    const e = ev({ id: "e1", secret: true });
    // inserted s3 first, then s1 — reading-order min is s1.
    const se: SceneEventRow[] = [
      { sceneId: "s3", eventId: "e1" },
      { sceneId: "s1", eventId: "e1" },
      { sceneId: "s2", eventId: "other" },
    ];
    expect(effectiveRevealSceneId(e, se, ORDER)).toBe("s1");
  });

  it("returns null when no stamps and no override (permanent secret)", () => {
    const e = ev({ id: "e1", secret: true });
    expect(effectiveRevealSceneId(e, [], ORDER)).toBeNull();
  });

  it("returns null when all stamps are outside reading order", () => {
    const e = ev({ id: "e1", secret: true });
    const se: SceneEventRow[] = [{ sceneId: "ghost", eventId: "e1" }];
    expect(effectiveRevealSceneId(e, se, ORDER)).toBeNull();
  });
});

describe("isEventHiddenFromAi", () => {
  const ctx = (sceneEvents: SceneEventRow[] = []) => ({
    readingOrder: ORDER,
    sceneEvents,
  });

  it("non-secret events are never hidden", () => {
    const e = ev({ id: "e1", secret: false, revealSceneId: "s3" });
    expect(isEventHiddenFromAi(e, "s0", ctx())).toBe(false);
  });

  it("hidden strictly before reveal, visible at and after reveal (>= boundary)", () => {
    const e = ev({ id: "e1", secret: true, revealSceneId: "s3" });
    expect(isEventHiddenFromAi(e, "s2", ctx())).toBe(true); // before
    expect(isEventHiddenFromAi(e, "s3", ctx())).toBe(false); // at reveal
    expect(isEventHiddenFromAi(e, "s4", ctx())).toBe(false); // after
  });

  it("auto-derived reveal from earliest stamp gates disclosure", () => {
    const e = ev({ id: "e1", secret: true });
    const se: SceneEventRow[] = [{ sceneId: "s2", eventId: "e1" }];
    expect(isEventHiddenFromAi(e, "s1", ctx(se))).toBe(true);
    expect(isEventHiddenFromAi(e, "s2", ctx(se))).toBe(false);
  });

  it("permanent secret (no reveal) is always hidden", () => {
    const e = ev({ id: "e1", secret: true });
    expect(isEventHiddenFromAi(e, "s4", ctx())).toBe(true);
  });

  it("fail-closed: current scene not in reading order is hidden", () => {
    const e = ev({ id: "e1", secret: true, revealSceneId: "s0" });
    // even though reveal is the very first scene, an unknown current scene hides it.
    expect(isEventHiddenFromAi(e, "ghost", ctx())).toBe(true);
  });

  it("fail-closed: empty current scene is hidden", () => {
    const e = ev({ id: "e1", secret: true, revealSceneId: "s0" });
    expect(isEventHiddenFromAi(e, "", ctx())).toBe(true);
  });

  it("reveal scene not in reading order is treated as unrevealed (hidden)", () => {
    const e = ev({ id: "e1", secret: true, revealSceneId: "ghost" });
    // Infinity comparison must NOT disclose: pos(s4)=4 < Infinity would be true,
    // but the explicit has() guard forces hidden.
    expect(isEventHiddenFromAi(e, "s4", ctx())).toBe(true);
  });
});

describe("projectVisibleChronicle", () => {
  it("drops hidden events and their scene_events / participants", () => {
    const events = [
      ev({ id: "pub" }),
      ev({ id: "sec", secret: true, revealSceneId: "s3" }),
    ];
    const sceneEvents: SceneEventRow[] = [
      { sceneId: "s0", eventId: "pub" },
      { sceneId: "s0", eventId: "sec" },
    ];
    const participants = [
      { eventId: "pub", codexEntryId: "c1", role: null },
      { eventId: "sec", codexEntryId: "c2", role: null },
    ];
    const relations = [{ causeId: "pub", effectId: "sec" }];
    const out = projectVisibleChronicle({
      events,
      sceneEvents,
      participants,
      relations,
      currentSceneId: "s0", // before reveal s3 → sec hidden
      readingOrder: ORDER,
    });
    expect(out.visibleEventIds.has("pub")).toBe(true);
    expect(out.visibleEventIds.has("sec")).toBe(false);
    expect(out.events.map((e) => e.id)).toEqual(["pub"]);
    expect(out.sceneEvents).toEqual([{ sceneId: "s0", eventId: "pub" }]);
    expect(out.participants.map((p) => p.codexEntryId)).toEqual(["c1"]);
    // relation with a hidden end is dropped entirely (no partial mask).
    expect(out.relations).toEqual([]);
  });

  it("is a no-op when nothing is secret (byte-identical arrays content)", () => {
    const events = [ev({ id: "a" }), ev({ id: "b" })];
    const sceneEvents: SceneEventRow[] = [{ sceneId: "s0", eventId: "a" }];
    const participants = [{ eventId: "b", codexEntryId: "c1", role: null }];
    const relations = [{ causeId: "a", effectId: "b" }];
    const out = projectVisibleChronicle({
      events,
      sceneEvents,
      participants,
      relations,
      currentSceneId: "s0",
      readingOrder: ORDER,
    });
    expect(out.events).toEqual(events);
    expect(out.sceneEvents).toEqual(sceneEvents);
    expect(out.participants).toEqual(participants);
    expect(out.relations).toEqual(relations);
  });

  it("discloses secret events at/after their reveal scene", () => {
    const events = [ev({ id: "sec", secret: true, revealSceneId: "s2" })];
    const out = projectVisibleChronicle({
      events,
      sceneEvents: [],
      participants: [],
      relations: [],
      currentSceneId: "s2",
      readingOrder: ORDER,
    });
    expect(out.visibleEventIds.has("sec")).toBe(true);
  });
});
