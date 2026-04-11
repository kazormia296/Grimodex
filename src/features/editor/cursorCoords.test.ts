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
    const result = toContainerRelative(coords, containerRect);

    expect(result).toEqual({ left: 100, top: 200, height: 20 });
  });

  it("handles zero container offset", () => {
    const coords: Coords = { left: 80, top: 40, bottom: 60 };
    const containerRect = { left: 0, top: 0 };
    const result = toContainerRelative(coords, containerRect);

    expect(result).toEqual({ left: 80, top: 40, height: 20 });
  });

  it("produces negative offsets when coords are above/left of container", () => {
    const coords: Coords = { left: 10, top: 20, bottom: 40 };
    const containerRect = { left: 50, top: 100 };
    const result = toContainerRelative(coords, containerRect);

    expect(result).toEqual({ left: -40, top: -80, height: 20 });
  });
});

// ---------------------------------------------------------------------------
// resolveCoords
// ---------------------------------------------------------------------------

function makeView(
  coordsAtPos: (_pos: number, side?: number) => Coords,
  domSelection?: unknown,
): EditorView {
  const doc = {
    ownerDocument: {
      defaultView: { getSelection: () => domSelection ?? null },
    },
  };
  return {
    coordsAtPos,
    dom: doc,
  } as unknown as EditorView;
}

const lineEnd: Coords = { left: 200, top: 100, bottom: 120 }; // end of previous line
const lineStart: Coords = { left: 10, top: 124, bottom: 144 }; // start of next line
const normal: Coords = { left: 80, top: 100, bottom: 120 };

describe("resolveCoords — non-wrap point", () => {
  it("returns coordsAtPos(from) when sides agree (same Y)", () => {
    const view = makeView((_pos, side) => {
      // Both sides return same Y
      if (side === -1) return { left: 80, top: 100, bottom: 120 };
      if (side === 1) return { left: 80, top: 100, bottom: 120 };
      return normal;
    });
    expect(resolveCoords(view, 5)).toEqual(normal);
  });

  it("returns null when coordsAtPos throws (non-wrap)", () => {
    const view = makeView(() => {
      throw new Error("atom node");
    });
    expect(resolveCoords(view, 5)).toBeNull();
  });
});

describe("resolveCoords — wrap point", () => {
  function makeWrapView(domSel: { top: number } | null) {
    const sel = domSel
      ? {
          isCollapsed: true,
          rangeCount: 1,
          getRangeAt: () => ({
            getClientRects: () => [
              { left: 0, top: domSel.top, bottom: domSel.top + 20 },
            ],
          }),
        }
      : null;

    return makeView((_pos, side) => {
      if (side === -1) return lineEnd;
      if (side === 1) return lineStart;
      // fallback (shouldn't be called at wrap point)
      return normal;
    }, sel);
  }

  it("picks line-end side when DOM Selection is on end line", () => {
    // DOM caret is at top=100 → same line as lineEnd (top=100)
    const view = makeWrapView({ top: 102 });
    expect(resolveCoords(view, 5)).toEqual(lineEnd);
  });

  it("picks line-start side when DOM Selection is on start line", () => {
    // DOM caret is at top=126 → same line as lineStart (top=124)
    const view = makeWrapView({ top: 126 });
    expect(resolveCoords(view, 5)).toEqual(lineStart);
  });

  it("falls back to line-start when DOM Selection is unavailable", () => {
    const view = makeWrapView(null);
    expect(resolveCoords(view, 5)).toEqual(lineStart);
  });

  it("falls back to line-start when getClientRects returns empty", () => {
    const emptyRectsSel = {
      isCollapsed: true,
      rangeCount: 1,
      getRangeAt: () => ({ getClientRects: () => [] }),
    };
    const view = makeView((_pos, side) => {
      if (side === -1) return lineEnd;
      if (side === 1) return lineStart;
      return normal;
    }, emptyRectsSel);
    expect(resolveCoords(view, 5)).toEqual(lineStart);
  });
});
