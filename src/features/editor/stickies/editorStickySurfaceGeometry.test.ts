import { describe, expect, it } from "vitest";
import {
  ensureEditorStickySurfaceSize,
  measureEditorStickySurface,
} from "./editorStickySurfaceGeometry";

describe("measureEditorStickySurface", () => {
  it("uses scrollWidth for the horizontal extent of vertical documents", () => {
    const measured = measureEditorStickySurface({
      clientWidth: 320,
      clientHeight: 640,
      scrollWidth: 1440,
      scrollHeight: 640,
      getBoundingClientRect: () => ({ width: 320, height: 640 }) as DOMRect,
    });

    expect(measured).toEqual({ width: 1440, height: 640 });
  });

  it("keeps the measured extent when placing the first sticky", () => {
    expect(
      ensureEditorStickySurfaceSize({ width: 1000, height: 700 }, 248, 520),
    ).toEqual({ width: 1000, height: 700 });
  });

  it("uses fallback bounds only when the surface has no measurable extent", () => {
    expect(
      ensureEditorStickySurfaceSize({ width: 0, height: 0 }, 248, 520),
    ).toEqual({ width: 248, height: 520 });
  });
});
