import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAutoSave } from "@/hooks/useAutoSave";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

import { toast } from "sonner";

describe("createAutoSave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not call save immediately", () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 2000);

    autoSave.schedule();
    expect(saveFn).not.toHaveBeenCalled();
  });

  it("calls save after the debounce delay", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 2000);

    autoSave.schedule();
    vi.advanceTimersByTime(2000);
    await vi.runAllTimersAsync();

    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it("resets the timer on repeated calls within the delay", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 2000);

    autoSave.schedule();
    vi.advanceTimersByTime(1500);
    autoSave.schedule(); // reset
    vi.advanceTimersByTime(1500);
    // Only 1500ms since last schedule, not yet 2000ms
    expect(saveFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    await vi.runAllTimersAsync();
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled", () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 2000);

    autoSave.schedule();
    autoSave.cancel();
    vi.advanceTimersByTime(3000);

    expect(saveFn).not.toHaveBeenCalled();
  });

  it("flush triggers immediate save and clears pending timer", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 2000);

    autoSave.schedule();
    await autoSave.flush();

    expect(saveFn).toHaveBeenCalledTimes(1);

    // Advancing should not trigger again
    vi.advanceTimersByTime(3000);
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it("does not call save on flush if nothing is scheduled", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 2000);

    await autoSave.flush();
    expect(saveFn).not.toHaveBeenCalled();
  });

  it("shows toast on schedule save failure", async () => {
    const saveFn = vi.fn().mockRejectedValue(new Error("disk full"));
    const autoSave = createAutoSave(saveFn, 500);

    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(500);

    expect(toast.error).toHaveBeenCalledWith("自動保存に失敗しました");
  });

  it("shows toast on flush failure", async () => {
    const saveFn = vi.fn().mockRejectedValue(new Error("disk full"));
    const autoSave = createAutoSave(saveFn, 5000);

    autoSave.schedule();
    await autoSave.flush();

    expect(toast.error).toHaveBeenCalledWith("自動保存に失敗しました");
  });
});
