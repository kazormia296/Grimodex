// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoSave } from "./useAutoSave";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

vi.mock("@/lib/a11y/announcer", () => ({
  announce: vi.fn(),
}));

describe("useAutoSave callback freshness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes the latest save callback after a rerender", async () => {
    const firstSave = vi.fn().mockResolvedValue(undefined);
    const latestSave = vi.fn().mockResolvedValue(undefined);
    const { result, rerender, unmount } = renderHook(
      ({ save }) => useAutoSave(save, 100),
      { initialProps: { save: firstSave } },
    );

    act(() => result.current.schedule());
    rerender({ save: latestSave });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(firstSave).not.toHaveBeenCalled();
    expect(latestSave).toHaveBeenCalledOnce();
    unmount();
  });
});
