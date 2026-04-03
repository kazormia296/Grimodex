import { describe, it, expect } from "vitest";
import { computeTypewriterScrollTop } from "./useTypewriterScroll";

describe("computeTypewriterScrollTop", () => {
  it("centers cursor in the visible area", () => {
    // container: scrollTop=0, height=600
    // cursor is at absolute top=300 (relative to viewport)
    // container top = 0
    // cursorRelativeY = 300 - 0 = 300
    // targetScrollTop = 0 + 300 - 600/2 = 0
    const result = computeTypewriterScrollTop(
      300, // cursorAbsoluteTop
      0, // containerAbsoluteTop
      0, // currentScrollTop
      600, // containerHeight
    );
    expect(result).toBe(0);
  });

  it("scrolls down when cursor is below center", () => {
    // container: scrollTop=0, height=600, containerTop=50
    // cursor absolute top = 450
    // cursorRelativeY = 450 - 50 = 400
    // targetScrollTop = 0 + 400 - 300 = 100
    const result = computeTypewriterScrollTop(450, 50, 0, 600);
    expect(result).toBe(100);
  });

  it("scrolls up when cursor is above center", () => {
    // container: scrollTop=200, height=600, containerTop=50
    // cursor absolute top = 100
    // cursorRelativeY = 100 - 50 = 50
    // targetScrollTop = 200 + 50 - 300 = -50
    const result = computeTypewriterScrollTop(100, 50, 200, 600);
    expect(result).toBe(-50);
  });

  it("returns 0 for cursor exactly at center", () => {
    // cursor at viewport center relative to container
    const result = computeTypewriterScrollTop(300, 0, 0, 600);
    expect(result).toBe(0);
  });
});
