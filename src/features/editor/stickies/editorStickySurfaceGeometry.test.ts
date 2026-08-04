import { describe, expect, it } from "vitest";
import { measureEditorStickySurface } from "./editorStickySurfaceGeometry";

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
});
