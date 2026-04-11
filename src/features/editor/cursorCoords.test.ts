import { describe, it, expect } from "vitest";
import {
  toContainerRelative,
  resolveCoords,
  resolveVerticalBias,
  type Coords,
} from "./cursorCoords";
import type { EditorView } from "@tiptap/pm/view";

// ---------------------------------------------------------------------------
// toContainerRelative
// ---------------------------------------------------------------------------
describe("toContainerRelative", () => {
  it("converts viewport coords to container-relative offsets", () => {
    const coords: Coords = { left: 150, top: 300, bottom: 320 };
    const containerRect = { left: 50, top: 100 };
    expect(toContainerRelative(coords, containerRect)).toEqual({
      left: 100,
      top: 200,
      height: 20,
    });
  });

  it("handles zero container offset", () => {
    const coords: Coords = { left: 80, top: 40, bottom: 60 };
    expect(toContainerRelative(coords, { left: 0, top: 0 })).toEqual({
      left: 80,
      top: 40,
      height: 20,
    });
  });

  it("produces negative offsets when coords are above/left of container", () => {
    const coords: Coords = { left: 10, top: 20, bottom: 40 };
    expect(toContainerRelative(coords, { left: 50, top: 100 })).toEqual({
      left: -40,
      top: -80,
      height: 20,
    });
  });
});

// ---------------------------------------------------------------------------
// resolveVerticalBias
// ---------------------------------------------------------------------------
describe("resolveVerticalBias", () => {
  it("returns null when not at a wrap boundary", () => {
    expect(resolveVerticalBias(100, 101, 160, "up")).toBeNull();
    expect(resolveVerticalBias(100, 100, 160, "down")).toBeNull();
  });

  // Reported bug: ArrowLeft (bias=-1) then ArrowUp lands at wrap boundary.
  // prevTop=160 (line 2), endTop=100 (line 0), startTop=130 (line 1).
  // Should pick startTop=130 (bias=1, line 1) — the closest line above.
  it("ArrowUp: picks line-start side when both above and start is closer", () => {
    expect(resolveVerticalBias(100, 130, 160, "up")).toBe(1);
  });

  // Triple-wrap: cursor at line 1 end (prevTop=130), ArrowUp lands at
  // wrap boundary between line 0 (endTop=100) and line 1 (startTop=130).
  // startTop=130 is NOT < 129, so only endTop qualifies → bias=-1.
  it("ArrowUp: picks line-end side when only it is above prevTop", () => {
    expect(resolveVerticalBias(100, 130, 130, "up")).toBe(-1);
  });

  it("ArrowUp: picks line-start side when only it is above prevTop", () => {
    expect(resolveVerticalBias(160, 130, 160, "up")).toBe(1);
  });

  it("ArrowUp: falls back to line-start when neither is above", () => {
    expect(resolveVerticalBias(170, 180, 160, "up")).toBe(1);
  });

  it("ArrowDown: picks line-end side when both below and end is closer", () => {
    // prevTop=100, endTop=130 (line 1 end), startTop=160 (line 2 start)
    expect(resolveVerticalBias(130, 160, 100, "down")).toBe(-1);
  });

  it("ArrowDown: picks line-end side when only it is below prevTop", () => {
    expect(resolveVerticalBias(130, 100, 100, "down")).toBe(-1);
  });

  it("ArrowDown: picks line-start side when only it is below prevTop", () => {
    expect(resolveVerticalBias(100, 130, 100, "down")).toBe(1);
  });

  it("ArrowDown: falls back to line-end when neither is below", () => {
    expect(resolveVerticalBias(80, 90, 160, "down")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// resolveCoords
// ---------------------------------------------------------------------------

const lineEnd: Coords = { left: 200, top: 100, bottom: 120 };
const lineStart: Coords = { left: 10, top: 124, bottom: 144 };

function makeView(
  coordsAtPos: (_pos: number, side?: number) => Coords,
): EditorView {
  return { coordsAtPos } as unknown as EditorView;
}

describe("resolveCoords", () => {
  it("returns coordsAtPos(from, -1) when bias is -1 (line-end side)", () => {
    const view = makeView((_pos, side) => (side === -1 ? lineEnd : lineStart));
    expect(resolveCoords(view, 5, -1)).toEqual(lineEnd);
  });

  it("returns coordsAtPos(from, 1) when bias is 1 (line-start side)", () => {
    const view = makeView((_pos, side) => (side === -1 ? lineEnd : lineStart));
    expect(resolveCoords(view, 5, 1)).toEqual(lineStart);
  });

  it("returns null when coordsAtPos throws", () => {
    const view = makeView(() => {
      throw new Error("atom node");
    });
    expect(resolveCoords(view, 5, 1)).toBeNull();
    expect(resolveCoords(view, 5, -1)).toBeNull();
  });

  it("passes the position through to coordsAtPos", () => {
    const positions: number[] = [];
    const view = makeView((pos) => {
      positions.push(pos);
      return lineStart;
    });
    resolveCoords(view, 42, 1);
    expect(positions[0]).toBe(42);
  });
});
