import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAutoSave,
  flushAllAutoSaves,
  registerAutoSaveForQuiesce,
  AlreadyNotifiedSaveError,
} from "@/hooks/useAutoSave";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

vi.mock("@/lib/a11y/announcer", () => ({
  announce: vi.fn(),
}));

import { toast } from "sonner";
import { announce } from "@/lib/a11y/announcer";
import i18next from "@/lib/i18n";
import { debugLog } from "@/lib/debugLog";

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

  it("pause keeps the queued edit, blocks quiesce, and resume persists it", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 500);

    autoSave.schedule();
    autoSave.pause();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveFn).not.toHaveBeenCalled();

    await expect(autoSave.flush()).rejects.toThrow(
      "unresolved external edit conflict",
    );
    expect(saveFn).not.toHaveBeenCalled();

    autoSave.resume();
    await vi.advanceTimersByTimeAsync(500);
    expect(saveFn).toHaveBeenCalledOnce();
  });

  it("edits scheduled while paused remain queued", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 500);

    autoSave.pause();
    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveFn).not.toHaveBeenCalled();

    autoSave.resume();
    await vi.advanceTimersByTimeAsync(500);
    expect(saveFn).toHaveBeenCalledOnce();
  });

  it("pause during an in-flight save holds the coalesced rerun", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const saveFn = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 500);

    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(saveFn).toHaveBeenCalledOnce();

    autoSave.schedule();
    autoSave.pause();
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(saveFn).toHaveBeenCalledOnce();
    await expect(autoSave.flush()).rejects.toThrow(
      "unresolved external edit conflict",
    );

    autoSave.resume();
    await vi.advanceTimersByTimeAsync(500);
    expect(saveFn).toHaveBeenCalledTimes(2);
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

  it("shows toast and propagates a flush failure", async () => {
    const saveFn = vi.fn().mockRejectedValue(new Error("disk full"));
    const autoSave = createAutoSave(saveFn, 5000);

    autoSave.schedule();
    await expect(autoSave.flush()).rejects.toThrow("disk full");

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

  it("flush は in-flight の save 完了を待つ (切替前 quiesce のすり抜け防止)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const saveFn = vi.fn(() => gate);
    const autoSave = createAutoSave(saveFn, 500);

    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(500); // runSave 開始 (pending=false, in-flight)
    expect(saveFn).toHaveBeenCalledTimes(1);

    let flushed = false;
    const flushing = autoSave.flush().then(() => {
      flushed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBe(false); // in-flight 完了までは resolve しない

    release();
    await flushing;
    expect(flushed).toBe(true);
    // pending は無かったので追加の save は走らない
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it("保存中の再 schedule は並行実行せず、完了後に最新状態を1回保存する", async () => {
    const gates: Array<() => void> = [];
    const saveFn = vi.fn(
      () =>
        new Promise<void>((r) => {
          gates.push(r);
        }),
    );
    const autoSave = createAutoSave(saveFn, 500);

    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(500); // run1 開始 (in-flight)
    expect(saveFn).toHaveBeenCalledTimes(1);

    let flushed = false;
    const flushing = autoSave.flush().then(() => {
      flushed = true;
    });
    // run1 中の再武装は rerun request に畳み込み、run2 を並行開始しない。
    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(saveFn).toHaveBeenCalledTimes(1);

    gates[0](); // run1 完了
    await vi.advanceTimersByTimeAsync(0);
    expect(saveFn).toHaveBeenCalledTimes(2);
    expect(flushed).toBe(false);

    gates[1](); // run2 完了
    await flushing;
    expect(flushed).toBe(true);
  });

  it("flush の drain が上限に達したら reject して quiesce 失敗を伝える", async () => {
    const warnSpy = vi.spyOn(debugLog, "warn");
    // save のたびに schedule を再誘発する病的ケース (持続タイピング相当)
    const holder: { schedule?: () => void } = {};
    const saveFn = vi.fn(async () => {
      holder.schedule?.();
    });
    const autoSave = createAutoSave(saveFn, 500);
    holder.schedule = autoSave.schedule;

    autoSave.schedule();
    await expect(autoSave.flush()).rejects.toThrow(
      "AutoSave queue did not reach quiescence",
    );

    expect(saveFn.mock.calls.length).toBeLessThanOrEqual(21);
    expect(
      warnSpy.mock.calls.some(
        ([tag, msg]) => tag === "AutoSave" && String(msg).includes("cap"),
      ),
    ).toBe(true);

    autoSave.cancel();
    warnSpy.mockRestore();
  });

  it("setDelay は待機中の debounce を新しい遅延で再武装する", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 2000);

    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(100);
    autoSave.setDelay(250);

    await vi.advanceTimersByTimeAsync(249);
    expect(saveFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(saveFn).toHaveBeenCalledOnce();
  });

  it("WORKSPACE_SWITCHING 拒否は i18n 済みの切替中文言で toast する", async () => {
    const saveFn = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "WORKSPACE_SWITCHING: workspace is switching; DB access is temporarily rejected",
        ),
      );
    const autoSave = createAutoSave(saveFn, 500);

    autoSave.schedule();
    await vi.advanceTimersByTimeAsync(500);

    expect(toast.error).toHaveBeenCalledWith(
      i18next.t("autoSave.workspaceSwitching"),
    );
  });
});

describe("flushAllAutoSaves (workspace 切替前 quiesce)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("登録済みインスタンスの pending save をすべて flush する", async () => {
    const saveA = vi.fn().mockResolvedValue(undefined);
    const saveB = vi.fn().mockResolvedValue(undefined);
    const a = createAutoSave(saveA, 2000);
    const b = createAutoSave(saveB, 2000);
    const unregisterA = registerAutoSaveForQuiesce(a);
    const unregisterB = registerAutoSaveForQuiesce(b);

    a.schedule();
    b.schedule();
    await flushAllAutoSaves();

    expect(saveA).toHaveBeenCalledTimes(1);
    expect(saveB).toHaveBeenCalledTimes(1);

    unregisterA();
    unregisterB();
  });

  it("登録解除後のインスタンスは flush されない", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 2000);
    const unregister = registerAutoSaveForQuiesce(autoSave);
    unregister();

    autoSave.schedule();
    await flushAllAutoSaves();
    expect(saveFn).not.toHaveBeenCalled();

    autoSave.cancel();
  });

  it("同じinstanceの重複登録は片方のcleanupで失われない", async () => {
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const autoSave = createAutoSave(saveFn, 2000);
    const unregisterA = registerAutoSaveForQuiesce(autoSave);
    const unregisterB = registerAutoSaveForQuiesce(autoSave);
    unregisterA();

    autoSave.schedule();
    await flushAllAutoSaves();
    expect(saveFn).toHaveBeenCalledOnce();

    unregisterB();
  });

  it("1件でも save に失敗したら reject して切替元へ伝える", async () => {
    const saveFn = vi.fn().mockRejectedValue(new Error("switching"));
    const autoSave = createAutoSave(saveFn, 2000);
    const unregister = registerAutoSaveForQuiesce(autoSave);

    autoSave.schedule();
    await expect(flushAllAutoSaves()).rejects.toThrow("switching");
    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalled();

    unregister();
  });
});
