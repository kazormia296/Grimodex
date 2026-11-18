import { describe, expect, it } from "vitest";
import type { SceneEventRow } from "./api";
import { isEventBeforeOrAtScene } from "./chronicleReadingPosition";
import { isEventHiddenFromAi, type ReadingOrder } from "./chronicleSecrecy";

// Reading order: s0 < s1 < s2 < s3. "gone" and "other" are not in it.
const readingOrder: ReadingOrder = new Map([
  ["s0", 0],
  ["s1", 1],
  ["s2", 2],
  ["s3", 3],
]);

function links(...pairs: [string, string][]): SceneEventRow[] {
  return pairs.map(([sceneId, eventId]) => ({ sceneId, eventId }));
}

function passes(
  eventId: string,
  currentSceneId: string,
  sceneEvents: SceneEventRow[],
  order: ReadingOrder = readingOrder,
): boolean {
  return isEventBeforeOrAtScene({ id: eventId }, currentSceneId, {
    readingOrder: order,
    sceneEvents,
  });
}

describe("isEventBeforeOrAtScene (B-T10, DR-CHATIR-S1-30)", () => {
  it("passes an event no Scene is tied to", () => {
    expect(passes("e1", "s1", [])).toBe(true);
    // A link of another event does not tie this one.
    expect(passes("e1", "s1", links(["s3", "e2"]))).toBe(true);
  });

  it("holds the boundary: one before passes, the same Scene passes, one after is dropped", () => {
    const current = "s2";
    expect(passes("e", current, links(["s1", "e"]))).toBe(true);
    expect(passes("e", current, links(["s2", "e"]))).toBe(true);
    expect(passes("e", current, links(["s3", "e"]))).toBe(false);
  });

  it("decides by the earliest tied Scene that is in the reading order", () => {
    // earliest (s1) is before the current Scene (s2): passes although s3 is after.
    expect(passes("e", "s2", links(["s3", "e"], ["s1", "e"]))).toBe(true);
    // every tied Scene is after: dropped.
    expect(passes("e", "s1", links(["s3", "e"], ["s2", "e"]))).toBe(false);
  });

  it("drops an event tied only to Scenes outside the reading order (fail-closed)", () => {
    expect(passes("e", "s2", links(["gone", "e"]))).toBe(false);
    expect(passes("e", "s2", links(["gone", "e"], ["other", "e"]))).toBe(false);
  });

  it("ignores a tied Scene outside the reading order when another one is inside", () => {
    expect(passes("e", "s2", links(["gone", "e"], ["s1", "e"]))).toBe(true);
    expect(passes("e", "s2", links(["gone", "e"], ["s3", "e"]))).toBe(false);
  });

  it("applies no filter when the current Scene is not in the reading order (plan X)", () => {
    expect(passes("e", "gone", links(["s3", "e"]))).toBe(true);
    expect(passes("e", "gone", links(["gone", "e"]))).toBe(true);
    expect(passes("e", "", links(["s3", "e"]))).toBe(true);
    expect(passes("e", "s1", links(["s3", "e"]), new Map())).toBe(true);
  });

  it("shares the secrecy filter's boundary (the current Scene is shown, an earlier one hides)", () => {
    // A secret event revealed at s2 is shown at s2 (current >= reveal);
    // the position filter also shows an event tied to s2 at s2.
    const ctx = { readingOrder, sceneEvents: links(["s2", "e"]) };
    const event = { id: "e", secret: true, revealSceneId: null };
    expect(isEventHiddenFromAi(event, "s2", ctx)).toBe(false);
    expect(passes("e", "s2", ctx.sceneEvents)).toBe(true);
    // Before the Scene both hide it.
    expect(isEventHiddenFromAi(event, "s1", ctx)).toBe(true);
    expect(passes("e", "s1", ctx.sceneEvents)).toBe(false);
  });

  it("does not change its input", () => {
    const sceneEvents = links(["s3", "e"], ["s1", "e"]);
    const frozen = JSON.stringify(sceneEvents);
    passes("e", "s2", sceneEvents);
    expect(JSON.stringify(sceneEvents)).toBe(frozen);
  });
});
