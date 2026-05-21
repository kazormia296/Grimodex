import { describe, it, expect } from "vitest";
import {
  clampRegionSize,
  computeFillerRegion,
  getMaxRegionSize,
  type RegionSizeClampContext,
} from "./layoutConstants";

const LAPTOP = { width: 1366, height: 768 };

const PLAN_FILLER_CONTEXT: RegionSizeClampContext = {
  centerBandVisible: false,
  leftOpen: true,
  rightOpen: true,
  hasLeft: true,
  hasRight: true,
  leftSize: 260,
  rightSize: 340,
  centerReserve: 0,
};

describe("computeFillerRegion", () => {
  it("chooses right as filler when center band hidden and both sides open", () => {
    expect(
      computeFillerRegion({
        centerBandVisible: false,
        leftOpen: true,
        rightOpen: true,
      }),
    ).toBe("right");
  });

  it("returns null when center band is visible", () => {
    expect(
      computeFillerRegion({
        centerBandVisible: true,
        leftOpen: true,
        rightOpen: true,
      }),
    ).toBeNull();
  });
});

describe("clampRegionSize with filler layout", () => {
  it("allows left region beyond 50% viewport when right is filler", () => {
    const halfViewport = Math.floor(LAPTOP.width * 0.5);
    const target = halfViewport + 200;
    expect(clampRegionSize("left", target, LAPTOP, PLAN_FILLER_CONTEXT)).toBe(
      target,
    );
  });

  it("caps left at viewport minus stripes, splitter, and min filler width", () => {
    const maxLeft = getMaxRegionSize("left", LAPTOP, PLAN_FILLER_CONTEXT);
    expect(maxLeft).toBe(LAPTOP.width - 32 * 2 - 6 - 120);
    expect(
      clampRegionSize("left", maxLeft + 500, LAPTOP, PLAN_FILLER_CONTEXT),
    ).toBe(maxLeft);
  });

  it("allows side region beyond 50% viewport when center band is visible", () => {
    const context: RegionSizeClampContext = {
      ...PLAN_FILLER_CONTEXT,
      centerBandVisible: true,
      leftSize: 200,
      rightSize: 500,
      centerReserve: 360,
    };
    const halfViewport = Math.floor(LAPTOP.width * 0.5);
    const maxRight = getMaxRegionSize("right", LAPTOP, context);
    expect(maxRight).toBeGreaterThan(halfViewport);
    expect(maxRight).toBe(LAPTOP.width - 32 * 2 - 6 * 2 - 360 - 200);
  });
});
