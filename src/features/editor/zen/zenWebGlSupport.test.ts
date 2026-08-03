// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetZenWebGl2SupportForTests,
  hasUsableZenWebGl2,
} from "./zenWebGlSupport";

describe("hasUsableZenWebGl2", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetZenWebGl2SupportForTests();
  });

  it("caches a usable WebGL2 probe and releases the temporary context", () => {
    const loseContext = vi.fn();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({
        getExtension: () => ({ loseContext }),
      } as unknown as WebGL2RenderingContext);

    expect(hasUsableZenWebGl2()).toBe(true);
    expect(hasUsableZenWebGl2()).toBe(true);
    expect(getContext).toHaveBeenCalledOnce();
    expect(getContext).toHaveBeenCalledWith(
      "webgl2",
      expect.objectContaining({
        antialias: false,
        failIfMajorPerformanceCaveat: true,
      }),
    );
    expect(loseContext).toHaveBeenCalledOnce();
  });

  it("uses the static fallback when WebGL2 is unavailable or probing throws", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(hasUsableZenWebGl2()).toBe(false);

    _resetZenWebGl2SupportForTests();
    vi.restoreAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => {
        throw new Error("blocked");
      },
    );
    expect(hasUsableZenWebGl2()).toBe(false);
  });
});
