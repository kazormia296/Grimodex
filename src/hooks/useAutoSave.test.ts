import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAutoSave, AlreadyNotifiedSaveError } from "@/hooks/useAutoSave";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

vi.mock("@/lib/a11y/announcer", () => ({
  announce: vi.fn(),
}));

import { toast } from "sonner";
import { announce } from "@/lib/a11y/announcer";
import i18next from "@/lib/i18n";

describe("createAutoSave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(toast.error).toHaveBeenCalledWith(
      "自動保存に失敗しました: disk full",
    );
  });

  it("shows toast on flush failure", async () => {
    const saveFn = vi.fn().mockRejectedValue(new Error("disk full"));
    const autoSave = createAutoSave(saveFn, 5000);

    autoSave.schedule();
    await autoSave.flush();

    expect(toast.error).toHaveBeenCalledWith(
      "自動保存に失敗しました: disk full",
    );
  });

  it("stays silent on ordinary successful saves (no announce)", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 500);

    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(500);

    expect(saveFn).toHaveBeenCalledTimes(2);
    expect(announce).not.toHaveBeenCalled();
  });

  it("announces once when a save succeeds after a failure", async () => {
    const saveFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 500);

    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(announce).not.toHaveBeenCalled();

    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(i18next.t("autoSave.recovered"));

    // Subsequent successes stay silent again.
    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("announces recovery via flush after a failed scheduled save", async () => {
    const saveFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 500);

    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(500);

    autoSave.schedule();
    await autoSave.flush();
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("AlreadyNotifiedSaveError では toast を重ねない (発生源で通知済み)", async () => {
    // 例: snippet の OCC 衝突は snippetStore が editConflict をトースト済み。
    // ここで autoSave.failed を重ねると同一失敗で二重トーストになる。
    const saveFn = vi
      .fn()
      .mockRejectedValueOnce(new AlreadyNotifiedSaveError("snippet conflict"))
      .mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 500);

    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(toast.error).not.toHaveBeenCalled();

    // toast を出さなくても「失敗」としては扱う (dirty 維持は呼び出し側、
    // 回復 announce はここ): 次の成功で recovered を1回読み上げる。
    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(i18next.t("autoSave.recovered"));
  });
});
