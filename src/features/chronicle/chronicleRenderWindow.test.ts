import { describe, expect, it } from "vitest";
import {
  buildChronicleHorizontalRenderWindow,
  buildChronicleVerticalRenderWindow,
  chronicleEdgeIntersectsHorizontalRenderWindow,
  chronicleEdgeIntersectsRenderWindow,
  chronicleMarkerIntersectsHorizontalRenderWindow,
  chronicleMarkerIntersectsRenderWindow,
} from "./chronicleRenderWindow";

describe("chronicleRenderWindow", () => {
  it("keeps the viewport plus one viewport of vertical overscan", () => {
    expect(
      buildChronicleVerticalRenderWindow({
        scrollTop: 900,
        viewportHeight: 300,
        contentHeight: 5_000,
      }),
    ).toEqual({ top: 600, bottom: 1_500 });
  });

  it("clamps at the content bounds and preserves an unmeasured fallback", () => {
    expect(
      buildChronicleVerticalRenderWindow({
        scrollTop: 0,
        viewportHeight: 300,
        contentHeight: 500,
      }),
    ).toEqual({ top: 0, bottom: 500 });
    expect(
      buildChronicleVerticalRenderWindow({
        scrollTop: 0,
        viewportHeight: 0,
        contentHeight: 5_000,
      }),
    ).toBeNull();
  });

  it("includes markers and causal spans that cross the render window", () => {
    const window = { top: 600, bottom: 1_500 };
    expect(
      chronicleMarkerIntersectsRenderWindow({
        markerTop: 590,
        markerHeight: 26,
        window,
      }),
    ).toBe(true);
    expect(
      chronicleMarkerIntersectsRenderWindow({
        markerTop: 1_501,
        markerHeight: 26,
        window,
      }),
    ).toBe(false);
    expect(
      chronicleMarkerIntersectsRenderWindow({
        markerTop: 1_700,
        markerHeight: 26,
        markerOffsetY: -700,
        window,
      }),
    ).toBe(true);
    expect(
      chronicleEdgeIntersectsRenderWindow({
        causeY: 200,
        effectY: 900,
        window,
      }),
    ).toBe(true);
    expect(
      chronicleEdgeIntersectsRenderWindow({
        causeY: 100,
        effectY: 500,
        window,
      }),
    ).toBe(false);
  });

  it("projects the track and one viewport of horizontal overscan into world coordinates", () => {
    expect(
      buildChronicleHorizontalRenderWindow({
        worldOffsetX: -400,
        viewportWidth: 800,
      }),
    ).toEqual({ left: -400, right: 2_000 });
    expect(
      buildChronicleHorizontalRenderWindow({
        worldOffsetX: 0,
        viewportWidth: 0,
      }),
    ).toBeNull();
  });

  it("includes horizontal marker and causal spans that cross the projected window", () => {
    const window = { left: 400, right: 1_200 };
    expect(
      chronicleMarkerIntersectsHorizontalRenderWindow({
        markerLeft: 380,
        markerWidth: 40,
        window,
      }),
    ).toBe(true);
    expect(
      chronicleMarkerIntersectsHorizontalRenderWindow({
        markerLeft: 1_201,
        markerWidth: 40,
        window,
      }),
    ).toBe(false);
    expect(
      chronicleEdgeIntersectsHorizontalRenderWindow({
        causeX: 100,
        effectX: 900,
        window,
      }),
    ).toBe(true);
    expect(
      chronicleEdgeIntersectsHorizontalRenderWindow({
        causeX: 100,
        effectX: 399,
        window,
      }),
    ).toBe(false);
  });
});
