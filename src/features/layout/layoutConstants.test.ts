import { describe, it, expect } from "vitest";
import {
  clampRegionSize,
  computeFillerRegion,
  getMaxRegionSize,
  LEGACY_SPLITTER_PX,
  MIN_REGION_SIZE,
  OUTER_PAD_PX,
  SPLITTER_GUTTER_PX,
  STRIPE_GAP_PX,
  STRIPE_SIZE,
  type RegionSizeClampContext,
} from "./layoutConstants";

/** stripe 本体 + その stripe ↔ content 間ギャップ列の合計 (片側)。 */
const STRIPE_CHROME = STRIPE_SIZE + STRIPE_GAP_PX;

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

  it("caps left at viewport minus outer pad, stripes, splitter, and min filler width", () => {
    const maxLeft = getMaxRegionSize("left", LAPTOP, PLAN_FILLER_CONTEXT);
    expect(maxLeft).toBe(
      LAPTOP.width -
        OUTER_PAD_PX * 2 -
        STRIPE_CHROME * 2 -
        SPLITTER_GUTTER_PX -
        MIN_REGION_SIZE,
    );
    expect(
      clampRegionSize("left", maxLeft + 500, LAPTOP, PLAN_FILLER_CONTEXT),
    ).toBe(maxLeft);
  });

  it("uses legacy chrome (no outer pad / gaps, 6px splitter) when mochi is off", () => {
    const ctx: RegionSizeClampContext = {
      ...PLAN_FILLER_CONTEXT,
      mochi: false,
    };
    const maxLeft = getMaxRegionSize("left", LAPTOP, ctx);
    expect(maxLeft).toBe(
      LAPTOP.width - STRIPE_SIZE * 2 - LEGACY_SPLITTER_PX - MIN_REGION_SIZE,
    );
  });

  it("allows side region beyond 50% viewport when center band is visible", () => {
    const context: RegionSizeClampContext = {
      ...PLAN_FILLER_CONTEXT,
      centerBandVisible: true,
      leftSize: 200,
      rightSize: 500,
      centerReserve: 300,
    };
    const halfViewport = Math.floor(LAPTOP.width * 0.5);
    const maxRight = getMaxRegionSize("right", LAPTOP, context);
    expect(maxRight).toBeGreaterThan(halfViewport);
    expect(maxRight).toBe(
      LAPTOP.width -
        OUTER_PAD_PX * 2 -
        STRIPE_CHROME * 2 -
        SPLITTER_GUTTER_PX * 2 -
        300 -
        200,
    );
  });
});
