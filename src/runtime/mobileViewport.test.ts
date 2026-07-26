import { describe, expect, it, vi } from "vitest";
import { installMobileViewportVars } from "./mobileViewport";

describe("installMobileViewportVars", () => {
  it("tracks visual viewport keyboard inset and removes listeners", () => {
    const listeners = new Map<string, () => void>();
    const visual = {
      height: 600,
      addEventListener: vi.fn(
        (type: "resize" | "scroll", listener: () => void) =>
          listeners.set(`visual:${type}`, listener),
      ),
      removeEventListener: vi.fn(),
    };
    const target = {
      innerHeight: 800,
      visualViewport: visual,
      addEventListener: vi.fn((_type: "resize", listener: () => void) =>
        listeners.set("window:resize", listener),
      ),
      removeEventListener: vi.fn(),
    };
    const setProperty = vi.fn();
    const cleanup = installMobileViewportVars(target, {
      style: { setProperty },
    });
    expect(setProperty).toHaveBeenCalledWith(
      "--visual-viewport-height",
      "600px",
    );
    expect(setProperty).toHaveBeenCalledWith("--keyboard-inset", "200px");
    visual.height = 780;
    listeners.get("visual:resize")?.();
    expect(setProperty).toHaveBeenCalledWith("--keyboard-inset", "20px");
    cleanup();
    expect(target.removeEventListener).toHaveBeenCalled();
    expect(visual.removeEventListener).toHaveBeenCalledTimes(2);
  });
});
