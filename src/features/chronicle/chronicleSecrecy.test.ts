import { describe, it, expect } from "vitest";
import type { SceneEventRow } from "./api";
import {
  readingPos,
  effectiveRevealSceneId,
  type ReadingOrder,
} from "./chronicleSecrecy";

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
    const e = { id: "e1", revealSceneId: "s3" };
    const se: SceneEventRow[] = [{ sceneId: "s1", eventId: "e1" }];
    expect(effectiveRevealSceneId(e, se, ORDER)).toBe("s3");
  });

  it("auto-derives the reading-order-min stamped scene (not insert order)", () => {
    const e = { id: "e1", revealSceneId: null };
    // inserted s3 first, then s1 — reading-order min is s1.
    const se: SceneEventRow[] = [
      { sceneId: "s3", eventId: "e1" },
      { sceneId: "s1", eventId: "e1" },
      { sceneId: "s2", eventId: "other" },
    ];
    expect(effectiveRevealSceneId(e, se, ORDER)).toBe("s1");
  });

  it("returns null when there are no stamps and no override", () => {
    const e = { id: "e1", revealSceneId: null };
    expect(effectiveRevealSceneId(e, [], ORDER)).toBeNull();
  });

  it("returns null when all stamps are outside reading order", () => {
    const e = { id: "e1", revealSceneId: null };
    const se: SceneEventRow[] = [{ sceneId: "ghost", eventId: "e1" }];
    expect(effectiveRevealSceneId(e, se, ORDER)).toBeNull();
  });
});
