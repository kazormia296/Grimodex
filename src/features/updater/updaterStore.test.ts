import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useUpdaterStore,
  AUTO_CLEAR_MS,
  _resetUpdaterForTests,
} from "./updaterStore";

describe("updaterStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetUpdaterForTests();
  });

  afterEach(() => {
    _resetUpdaterForTests();
    vi.useRealTimers();
  });

  it("starts idle", () => {
    const s = useUpdaterStore.getState();
    expect(s.phase).toBe("idle");
    expect(s.version).toBeNull();
    expect(s.notes).toBeNull();
    expect(s.error).toBeNull();
  });

  it("setAvailable records version/notes and does NOT auto-clear", () => {
    useUpdaterStore.getState().setAvailable("1.2.3", "リリースノート");
    const s = useUpdaterStore.getState();
    expect(s.phase).toBe("available");
    expect(s.version).toBe("1.2.3");
    expect(s.notes).toBe("リリースノート");

    // available はユーザー操作待ち: いくら時間が経っても消えない
    vi.advanceTimersByTime(AUTO_CLEAR_MS * 3);
    expect(useUpdaterStore.getState().phase).toBe("available");
  });

  it("setDownloading tracks progress and setReady flips to ready", () => {
    useUpdaterStore.getState().setDownloading(40, 100);
    let s = useUpdaterStore.getState();
    expect(s.phase).toBe("downloading");
    expect(s.downloaded).toBe(40);
    expect(s.total).toBe(100);

    useUpdaterStore.getState().setReady();
    s = useUpdaterStore.getState();
    expect(s.phase).toBe("ready");
    // ready も自動では消えない
    vi.advanceTimersByTime(AUTO_CLEAR_MS * 3);
    expect(useUpdaterStore.getState().phase).toBe("ready");
  });

  it("setUpToDate auto-clears to idle after AUTO_CLEAR_MS", () => {
    useUpdaterStore.getState().setUpToDate();
    expect(useUpdaterStore.getState().phase).toBe("upToDate");

    vi.advanceTimersByTime(AUTO_CLEAR_MS - 1);
    expect(useUpdaterStore.getState().phase).toBe("upToDate");
    vi.advanceTimersByTime(1);
    expect(useUpdaterStore.getState().phase).toBe("idle");
  });

  it("setError records message and auto-clears to idle", () => {
    useUpdaterStore.getState().setError("boom");
    let s = useUpdaterStore.getState();
    expect(s.phase).toBe("error");
    expect(s.error).toBe("boom");

    vi.advanceTimersByTime(AUTO_CLEAR_MS);
    s = useUpdaterStore.getState();
    expect(s.phase).toBe("idle");
    expect(s.error).toBeNull();
  });

  it("a later transition cancels a pending auto-clear timer", () => {
    useUpdaterStore.getState().setError("boom");
    vi.advanceTimersByTime(AUTO_CLEAR_MS - 100);

    // 自動消滅前に別の遷移 (再チェック) が入るとタイマーは破棄される
    useUpdaterStore.getState().setChecking();
    vi.advanceTimersByTime(AUTO_CLEAR_MS);
    expect(useUpdaterStore.getState().phase).toBe("checking");
  });

  it("reset immediately returns to idle and clears the timer", () => {
    useUpdaterStore.getState().setError("boom");
    useUpdaterStore.getState().reset();
    expect(useUpdaterStore.getState().phase).toBe("idle");
    vi.advanceTimersByTime(AUTO_CLEAR_MS * 2);
    expect(useUpdaterStore.getState().phase).toBe("idle");
  });
});
