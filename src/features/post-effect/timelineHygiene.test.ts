import { describe, it, expect } from "vitest";
import {
  detectTimelineHygiene,
  type TimelineHygieneScene,
} from "./timelineHygiene";

function s(
  id: string,
  storyTimeOrder: string | null,
  title = `Scene ${id}`,
): TimelineHygieneScene {
  return { id, title, storyTimeOrder };
}

describe("detectTimelineHygiene", () => {
  it("returns nothing for distinct, well-formed keys", () => {
    expect(
      detectTimelineHygiene([s("a", "a0"), s("b", "a1"), s("c", "b0")]),
    ).toEqual([]);
  });

  it("ignores unplaced (null) scenes entirely", () => {
    expect(
      detectTimelineHygiene([s("a", null), s("b", null), s("c", "a0")]),
    ).toEqual([]);
  });

  it("flags duplicate story_time_order keys, cross-referencing conflicts", () => {
    const findings = detectTimelineHygiene([
      s("a", "a0"),
      s("b", "a0"),
      s("c", "b0"),
    ]);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.kind === "duplicate_order")).toBe(true);
    const a = findings.find((f) => f.sceneId === "a");
    expect(a?.conflictsWith).toEqual(["b"]);
    expect(findings.find((f) => f.sceneId === "b")?.conflictsWith).toEqual([
      "a",
    ]);
  });

  it("groups 3-way duplicates with all peers listed", () => {
    const findings = detectTimelineHygiene([
      s("a", "a0"),
      s("b", "a0"),
      s("c", "a0"),
    ]);
    expect(findings).toHaveLength(3);
    expect(
      findings.find((f) => f.sceneId === "a")?.conflictsWith?.sort(),
    ).toEqual(["b", "c"]);
  });

  it("flags malformed (non-null empty/whitespace) keys", () => {
    const findings = detectTimelineHygiene([
      s("a", ""),
      s("b", "   "),
      s("c", "a0"),
    ]);
    expect(findings.map((f) => f.kind)).toEqual([
      "malformed_order",
      "malformed_order",
    ]);
    expect(findings.map((f) => f.sceneId).sort()).toEqual(["a", "b"]);
  });
});
