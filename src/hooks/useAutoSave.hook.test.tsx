// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAllAutoSaves, useAutoSave } from "./useAutoSave";

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

  it("keeps an unmounted pending save registered until it settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = vi.fn(() => gate);
    const { result, unmount } = renderHook(() => useAutoSave(save, 100));

    act(() => result.current.schedule());
    unmount();

    let quiesced = false;
    const quiescing = flushAllAutoSaves().then(() => {
      quiesced = true;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(save).toHaveBeenCalledOnce();
    expect(quiesced).toBe(false);

    release();
    await quiescing;
    expect(quiesced).toBe(true);
  });

  it("retains a failed unmount flush for the next global quiesce retry", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useAutoSave(save, 100));

    act(() => result.current.schedule());
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(save).toHaveBeenCalledOnce();

    await flushAllAutoSaves();
    expect(save).toHaveBeenCalledTimes(2);

    await flushAllAutoSaves();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("explicit discard cancels a paused edit before unmount retirement", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useAutoSave(save, 100));

    act(() => {
      result.current.schedule();
      result.current.pause();
      // Mirrors the tab's explicit "Close without saving" handler.
      result.current.cancel();
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await expect(flushAllAutoSaves()).resolves.toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });
});
