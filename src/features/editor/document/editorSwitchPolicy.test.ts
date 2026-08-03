import { describe, expect, it, vi } from "vitest";
import { handlePreSwitchFlushFailure } from "./editorSwitchPolicy";

describe("handlePreSwitchFlushFailure", () => {
  it("restores the previous tab before load invalidates the old binding", () => {
    const restorePrimary = vi.fn();

    expect(
      handlePreSwitchFlushFailure({
        loadStarted: false,
        previousId: "scene-a",
        currentId: "scene-b",
        groupIndex: 0,
        restorePrimary,
        restoreSecondary: vi.fn(),
      }),
    ).toBe(true);
    expect(restorePrimary).toHaveBeenCalledWith("scene-a");
  });

  it("does not handle failures after the new load has started", () => {
    const restorePrimary = vi.fn();

    expect(
      handlePreSwitchFlushFailure({
        loadStarted: true,
        previousId: "scene-a",
        currentId: "scene-b",
        groupIndex: 0,
        restorePrimary,
        restoreSecondary: vi.fn(),
      }),
    ).toBe(false);
    expect(restorePrimary).not.toHaveBeenCalled();
  });

  it("restores a same-id document projection before the old binding is invalidated", () => {
    const restoreDocumentProjection = vi.fn();

    expect(
      handlePreSwitchFlushFailure({
        loadStarted: false,
        previousId: "codex-1",
        currentId: "codex-1",
        groupIndex: 0,
        restorePrimary: vi.fn(),
        restoreSecondary: vi.fn(),
        restoreDocumentProjection,
      }),
    ).toBe(true);
    expect(restoreDocumentProjection).toHaveBeenCalledOnce();
  });
});
