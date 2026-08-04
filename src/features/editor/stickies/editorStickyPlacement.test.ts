import { describe, expect, it } from "vitest";
import {
  applyStickyPhysicalDelta,
  clampStickyPosition,
  logicalToPhysicalPosition,
  physicalToLogicalPosition,
} from "./editorStickyPlacement";

describe("editor sticky logical placement", () => {
  it("round-trips horizontal positions without changing the saved logical values", () => {
    const logical = { inlineOffset: 120, blockOffset: 48 };
    const physical = logicalToPhysicalPosition(logical, {
      verticalMode: false,
      surfaceWidth: 800,
      stickyWidth: 200,
    });

    expect(physical).toEqual({ left: 120, top: 48 });
    expect(
      physicalToLogicalPosition(physical, {
        verticalMode: false,
        surfaceWidth: 800,
        stickyWidth: 200,
      }),
    ).toEqual(logical);
  });

  it("projects vertical-rl positions while keeping the sticky body horizontal", () => {
    const logical = { inlineOffset: 72, blockOffset: 140 };
    const physical = logicalToPhysicalPosition(logical, {
      verticalMode: true,
      surfaceWidth: 900,
      stickyWidth: 200,
    });

    expect(physical).toEqual({ left: 560, top: 72 });
    expect(
      physicalToLogicalPosition(physical, {
        verticalMode: true,
        surfaceWidth: 900,
        stickyWidth: 200,
      }),
    ).toEqual(logical);
  });

  it("maps pointer deltas into inline/block deltas in vertical writing", () => {
    expect(
      applyStickyPhysicalDelta(
        { inlineOffset: 100, blockOffset: 200 },
        { deltaX: 12, deltaY: -8 },
        true,
      ),
    ).toEqual({ inlineOffset: 92, blockOffset: 188 });
  });

  it("keeps at least the drag handle visible without mutating the saved position", () => {
    expect(
      clampStickyPosition(
        { left: -500, top: 1200 },
        { surfaceWidth: 800, surfaceHeight: 600, stickyWidth: 200, stickyHeight: 96 },
      ),
    ).toEqual({ left: -176, top: 576 });
  });
});
