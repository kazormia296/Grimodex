import { describe, expect, it } from "vitest";
import { REGION_DRAWER, overlaySlideTransitions } from "./layoutAnimation";
import { OVERLAY_DURATIONS } from "@/lib/animation";

describe("layoutAnimation", () => {
  it("clips only the stripe-side edge of each region drawer", () => {
    // stripe 側の 1 辺だけを 0 で切り、残りは負の inset で shadow を逃がす。
    expect(REGION_DRAWER.left.clip).toBe("inset(-200px -200px -200px 0px)");
    expect(REGION_DRAWER.right.clip).toBe("inset(-200px 0px -200px -200px)");
    expect(REGION_DRAWER.bottom.clip).toBe("inset(-200px -200px 0px -200px)");
    // 閉じた位置は stripe の側（左は負、右と下は正）。
    expect(REGION_DRAWER.left.sign).toBe(-1);
    expect(REGION_DRAWER.right.sign).toBe(1);
    expect(REGION_DRAWER.bottom).toMatchObject({ axis: "y", sign: 1 });
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
