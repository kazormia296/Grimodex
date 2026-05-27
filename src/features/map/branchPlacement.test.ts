import { describe, expect, it } from "vitest";
import {
  BRANCH_BASE_OFFSET,
  findNonOverlappingBranchPosition,
  type Rect,
} from "./branchPlacement";

const STICKY = { w: 200, h: 120 };

describe("findNonOverlappingBranchPosition", () => {
  it("returns horizontal-right placement when nothing blocks", () => {
    const result = findNonOverlappingBranchPosition(
      { x: 300, y: 200 },
      STICKY,
      "right",
      [],
    );
    expect(result.x).toBeCloseTo(300 + BRANCH_BASE_OFFSET, 5);
    expect(result.y).toBeCloseTo(200, 5);
  });

  it("returns horizontal-left placement when nothing blocks", () => {
    const result = findNonOverlappingBranchPosition(
      { x: 500, y: 200 },
      STICKY,
      "left",
      [],
    );
    expect(result.x).toBeCloseTo(500 - BRANCH_BASE_OFFSET, 5);
    expect(result.y).toBeCloseTo(200, 5);
  });

  it("tilts off horizontal when a node blocks the 0° slot", () => {
    // Block exactly the (300+280, 200) horizontal slot.
    const blocker: Rect = { x: 300 + BRANCH_BASE_OFFSET, y: 200, ...STICKY };
    const result = findNonOverlappingBranchPosition(
      { x: 300, y: 200 },
      STICKY,
      "right",
      [blocker],
    );
    expect(result.y).not.toBeCloseTo(200, 5);
    // Still on the right half-plane relative to source.
    expect(result.x).toBeGreaterThan(300);
  });

  it("prefers small angles over large ones at the same radius", () => {
    // A short blocker on the horizontal slot — the 0° candidate (200×120)
    // collides, but the 15° candidate clears it vertically.
    const blocker: Rect = {
      x: 300 + BRANCH_BASE_OFFSET,
      y: 200,
      w: 200,
      h: 40,
    };
    const result = findNonOverlappingBranchPosition(
      { x: 300, y: 200 },
      STICKY,
      "right",
      [blocker],
    );
    const expected15 = BRANCH_BASE_OFFSET * Math.sin((15 * Math.PI) / 180);
    expect(Math.abs(Math.abs(result.y - 200) - expected15)).toBeLessThan(1);
  });

  it("expands the radius when the entire base half-circle is blocked", () => {
    // Fill the half-circle at the base radius with blockers.
    const blockers: Rect[] = [];
    for (let deg = -90; deg <= 90; deg += 5) {
      const rad = (deg * Math.PI) / 180;
      const cx = 300 + BRANCH_BASE_OFFSET * Math.cos(rad);
      const cy = 200 + BRANCH_BASE_OFFSET * Math.sin(rad);
      blockers.push({ x: cx - 100, y: cy - 60, w: 200, h: 120 });
    }
    const result = findNonOverlappingBranchPosition(
      { x: 300, y: 200 },
      STICKY,
      "right",
      blockers,
    );
    const dist = Math.hypot(result.x - 300, result.y - 200);
    expect(dist).toBeGreaterThan(BRANCH_BASE_OFFSET);
  });

  it("ignores rects far above/below the source", () => {
    const blocker: Rect = { x: 300 + BRANCH_BASE_OFFSET, y: 2000, ...STICKY };
    const result = findNonOverlappingBranchPosition(
      { x: 300, y: 200 },
      STICKY,
      "right",
      [blocker],
    );
    expect(result.x).toBeCloseTo(300 + BRANCH_BASE_OFFSET, 5);
    expect(result.y).toBeCloseTo(200, 5);
  });
});
