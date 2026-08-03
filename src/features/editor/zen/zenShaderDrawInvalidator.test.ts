import { describe, expect, it, vi } from "vitest";
import { createZenShaderDrawInvalidator } from "./zenShaderDrawInvalidator";

describe("createZenShaderDrawInvalidator", () => {
  it("coalesces frame and uniform invalidations into one draw", () => {
    let callback: FrameRequestCallback | undefined;
    const draw = vi.fn();
    const invalidator = createZenShaderDrawInvalidator(draw, {
      request: (next) => {
        callback = next;
        return 1;
      },
      cancel: vi.fn(),
    });

    invalidator.invalidate();
    invalidator.invalidate();
    expect(draw).not.toHaveBeenCalled();

    callback?.(16.67);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenCalledWith(16.67);
  });

  it("cancels a pending draw when disposed", () => {
    const cancel = vi.fn();
    const invalidator = createZenShaderDrawInvalidator(vi.fn(), {
      request: () => 42,
      cancel,
    });

    invalidator.invalidate();
    invalidator.dispose();
    expect(cancel).toHaveBeenCalledWith(42);
  });
});
