import { describe, expect, it } from "vitest";
import type { SceneEventRow } from "./api";
import {
  isEventBeforeOrAtScene,
  passesIrExclusionApproximation,
} from "./chronicleReadingPosition";
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

describe("passesIrExclusionApproximation (S1-A2b, DR-CHATIR-S1-45)", () => {
  function approx(
    secret: boolean,
    currentSceneId: string,
    sceneEvents: SceneEventRow[],
    order: ReadingOrder = readingOrder,
  ): boolean {
    return passesIrExclusionApproximation({ id: "e", secret }, currentSceneId, {
      readingOrder: order,
      sceneEvents,
    });
  }

  it("passes an event that is not secret whatever it is tied to", () => {
    expect(approx(false, "s2", links(["s2", "e"], ["s3", "e"]))).toBe(true);
    expect(approx(false, "s2", links(["gone", "e"]))).toBe(true);
    expect(approx(false, "", links(["s3", "e"]))).toBe(true);
  });

  it("passes a secret event only when every tied Scene is strictly before the current one", () => {
    expect(approx(true, "s2", links(["s1", "e"]))).toBe(true);
    expect(approx(true, "s2", links(["s0", "e"], ["s1", "e"]))).toBe(true);
    // The same Scene is not before (the IR drops a source at the current Scene).
    expect(approx(true, "s2", links(["s2", "e"]))).toBe(false);
    expect(approx(true, "s2", links(["s3", "e"]))).toBe(false);
  });

  it("judges by every tie, not the earliest one (the opposite of the position filter)", () => {
    const ties = links(["s1", "e"], ["s2", "e"]);
    expect(passes("e", "s2", ties)).toBe(true);
    expect(approx(true, "s2", ties)).toBe(false);
    expect(approx(true, "s2", links(["s1", "e"], ["s3", "e"]))).toBe(false);
  });

  it("does not pass a secret event tied to a Scene outside the reading order", () => {
    expect(approx(true, "s2", links(["s1", "e"], ["gone", "e"]))).toBe(false);
    expect(approx(true, "s2", links(["gone", "e"]))).toBe(false);
  });

  it("does not pass a secret event when the current Scene is empty or outside the order", () => {
    expect(approx(true, "", links(["s1", "e"]))).toBe(false);
    expect(approx(true, "gone", links(["s1", "e"]))).toBe(false);
  });

  it("passes a secret event no Scene is tied to, and ignores another event's links", () => {
    expect(approx(true, "s2", [])).toBe(true);
    expect(approx(true, "s2", links(["s3", "other"]))).toBe(true);
  });
});
