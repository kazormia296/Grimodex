import { describe, expect, it } from "vitest";
import {
  computeStripeAxisLockInsertIndex,
  computeStripeAxisLockPxOffsets,
  computeStripeAxisLockShifts,
  offAxisDelta,
  resolveStripeDragMode,
  stripeAxisForRegion,
} from "./layoutStripeSwap";
import { STRIPE_SWAP_AXIS_LOCK_PX } from "./layoutConstants";
import type { ToolWindowPanelId } from "./layoutTypes";

describe("resolveStripeDragMode", () => {
  const threshold = STRIPE_SWAP_AXIS_LOCK_PX;

  it("stays axis-locked below threshold", () => {
    expect(resolveStripeDragMode("axis-locked", 50, threshold)).toBe(
      "axis-locked",
    );
  });

  it("escapes to free at threshold", () => {
    expect(resolveStripeDragMode("axis-locked", 120, threshold)).toBe("free");
  });

  it("hysteresis: free never reverts to axis-locked", () => {
    expect(resolveStripeDragMode("free", 0, threshold)).toBe("free");
    expect(resolveStripeDragMode("free", 5, threshold)).toBe("free");
  });
});

describe("stripeAxisForRegion / offAxisDelta", () => {
  it("left/right use vertical axis (off-axis = X)", () => {
    expect(stripeAxisForRegion("left")).toBe("vertical");
    expect(offAxisDelta("vertical", 10, 0)).toBe(10);
  });

  it("bottom/center use horizontal axis (off-axis = Y)", () => {
    expect(stripeAxisForRegion("bottom")).toBe("horizontal");
    expect(offAxisDelta("horizontal", 0, 10)).toBe(10);
  });
});

describe("computeStripeAxisLockInsertIndex", () => {
  const panels = ["chat", "scenes", "codex"] as ToolWindowPanelId[];
  const rects = {
    chat: { start: 0, end: 28 },
    scenes: { start: 30, end: 58 },
    codex: { start: 60, end: 88 },
  };

  it("returns null when pointer stays within active slot", () => {
    expect(
      computeStripeAxisLockInsertIndex("scenes", 44, panels, rects),
    ).toBeNull();
  });

  it("moves before upper neighbor when pointer crosses upper midpoint", () => {
    expect(computeStripeAxisLockInsertIndex("scenes", 10, panels, rects)).toBe(
      0,
    );
  });

  it("moves after lower neighbor when pointer crosses lower midpoint", () => {
    expect(computeStripeAxisLockInsertIndex("scenes", 80, panels, rects)).toBe(
      3,
    );
  });

  it("skips past multiple neighbors upward", () => {
    expect(computeStripeAxisLockInsertIndex("codex", 5, panels, rects)).toBe(0);
  });

  it("skips past multiple neighbors downward", () => {
    expect(computeStripeAxisLockInsertIndex("chat", 90, panels, rects)).toBe(3);
  });

  it("returns null for single-panel slot", () => {
    expect(
      computeStripeAxisLockInsertIndex("chat", 0, ["chat"], {
        chat: rects.chat,
      }),
    ).toBeNull();
  });

  it("returns null when active id is unknown", () => {
    expect(
      computeStripeAxisLockInsertIndex(
        "ghost" as ToolWindowPanelId,
        0,
        panels,
        rects,
      ),
    ).toBeNull();
  });

  it("returns null when no sibling rects are provided", () => {
    expect(
      computeStripeAxisLockInsertIndex("scenes", 50, panels, {}),
    ).toBeNull();
  });
});

describe("computeStripeAxisLockShifts", () => {
  const panels = ["chat", "scenes", "codex"] as ToolWindowPanelId[];
  const rects = {
    chat: { start: 0, end: 28 },
    scenes: { start: 30, end: 58 },
    codex: { start: 60, end: 88 },
  };

  it("returns empty map when no displacement", () => {
    expect(computeStripeAxisLockShifts("scenes", 44, panels, rects).size).toBe(
      0,
    );
  });

  it("shifts upper sibling toward-end when active moves above it", () => {
    const shifts = computeStripeAxisLockShifts("scenes", 10, panels, rects);
    expect(shifts.get("chat")).toBe("toward-end");
    expect(shifts.has("codex")).toBe(false);
  });

  it("shifts lower sibling toward-start when active moves below it", () => {
    const shifts = computeStripeAxisLockShifts("scenes", 80, panels, rects);
    expect(shifts.get("codex")).toBe("toward-start");
    expect(shifts.has("chat")).toBe(false);
  });

  it("shifts multiple siblings when active jumps two slots", () => {
    const shifts = computeStripeAxisLockShifts("codex", 5, panels, rects);
    expect(shifts.get("chat")).toBe("toward-end");
    expect(shifts.get("scenes")).toBe("toward-end");
  });

  it("excludes active itself from the shift map", () => {
    const shifts = computeStripeAxisLockShifts("scenes", 10, panels, rects);
    expect(shifts.has("scenes")).toBe(false);
  });
});

describe("computeStripeAxisLockPxOffsets", () => {
  const panels = ["chat", "scenes", "codex", "grid"] as ToolWindowPanelId[];
  const rects = {
    chat: { start: 0, end: 20 },
    scenes: { start: 22, end: 50 },
    codex: { start: 52, end: 72 },
    grid: { start: 74, end: 94 },
  };
  const gap = 2;
  const activeSlot = 50 - 22 + gap;

  it("returns empty when no displacement", () => {
    expect(
      Object.keys(
        computeStripeAxisLockPxOffsets("scenes", 36, panels, rects, gap),
      ).length,
    ).toBe(0);
  });

  it("active shifts by lower-sibling slot height, sibling shifts by active slot", () => {
    const offsets = computeStripeAxisLockPxOffsets(
      "scenes",
      65,
      panels,
      rects,
      gap,
    );
    expect(offsets.codex).toBe(-activeSlot);
    expect(offsets.scenes).toBe(72 - 52 + gap);
  });

  it("upward pass: active moves toward-start, sibling moves toward-end", () => {
    const offsets = computeStripeAxisLockPxOffsets(
      "scenes",
      5,
      panels,
      rects,
      gap,
    );
    expect(offsets.chat).toBe(activeSlot);
    expect(offsets.scenes).toBe(-(20 + gap));
  });
});
