import { describe, it, expect } from "vitest";
import {
  computeTypewriterScrollTop,
  computeTypewriterScrollLeft,
} from "./useTypewriterScroll";

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

describe("computeTypewriterScrollLeft (vertical writing)", () => {
  it("centers the cursor column horizontally", () => {
    // container: scrollLeft=0, width=800, left=0; cursor at left=400 (center)
    // targetScrollLeft = 0 + (400 - 0) - 800/2 = 0
    expect(computeTypewriterScrollLeft(400, 0, 0, 800)).toBe(0);
  });

  it("scrolls so a cursor right of center moves toward center (delta > 0)", () => {
    // cursor at left=600, container left=0, width=800 → delta = 600 - 400 = 200
    expect(computeTypewriterScrollLeft(600, 0, 0, 800)).toBe(200);
  });

  it("allows negative targets (Chromium vertical-rl scrollLeft regime)", () => {
    // cursor left of center, current scrollLeft already negative
    // 0 offset container; cursor at 100, width 800 → -100 relative to current 0
    expect(computeTypewriterScrollLeft(100, 0, 0, 800)).toBe(-300);
    // with an already-negative current scrollLeft it composes relatively
    expect(computeTypewriterScrollLeft(100, 0, -50, 800)).toBe(-350);
  });

  it("accounts for container's own left offset", () => {
    // container left=50; cursor absolute left=450 → relative 400, width 800
    // target = 0 + 400 - 400 = 0
    expect(computeTypewriterScrollLeft(450, 50, 0, 800)).toBe(0);
  });
});
