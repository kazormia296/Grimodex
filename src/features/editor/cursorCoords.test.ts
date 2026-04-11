import { describe, it, expect } from "vitest";
import {
  toContainerRelative,
  resolveCoords,
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
