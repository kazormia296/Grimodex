import { describe, expect, it } from "vitest";
import {
  REGION_CLIP_PATH,
  REGION_TRANSFORM_ORIGIN,
  overlaySlideTransitions,
} from "./layoutAnimation";
import { OVERLAY_DURATIONS } from "@/lib/animation";

describe("layoutAnimation", () => {
  it("defines clip paths and transform origins for each region chrome", () => {
    expect(REGION_CLIP_PATH.left.open).toContain("inset(");
    expect(REGION_CLIP_PATH.left.closed).toContain("inset(");
    expect(REGION_TRANSFORM_ORIGIN.bottom).toBe("bottom center");
  });

  it("slides the overlay flat over OVERLAY_DURATIONS.slide", () => {
    const opening = overlaySlideTransitions(false, true);
    expect(OVERLAY_DURATIONS.slide).toBe(0.3);
    expect(opening.panel).toContain("300ms");
    // 開くときは visibility を遅らせない。
    expect(opening.layer).toBe("visibility 0ms linear 0ms");
    // 閉じるときはスライドが終わってから不可視にする。
    expect(overlaySlideTransitions(false, false).layer).toBe(
      "visibility 0ms linear 300ms",
    );
  });

  it("drops the overlay transition entirely under Reduced Motion", () => {
    expect(overlaySlideTransitions(true, true)).toEqual({
      panel: "none",
      layer: "none",
    });
    expect(overlaySlideTransitions(true, false)).toEqual({
      panel: "none",
      layer: "none",
    });
  });
});
