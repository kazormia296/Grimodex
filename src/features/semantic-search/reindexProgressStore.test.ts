import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useReindexProgressStore,
  AUTO_CLEAR_MS,
  _resetReindexProgressForTests,
} from "./reindexProgressStore";

describe("reindexProgressStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetReindexProgressForTests();
  });

  afterEach(() => {
    _resetReindexProgressForTests();
    vi.useRealTimers();
  });

  it("starts inactive", () => {
    const s = useReindexProgressStore.getState();
    expect(s.active).toBe(false);
    expect(s.current).toBeNull();
    expect(s.finished).toBe(false);
  });

  it("setProgress activates and records current payload", () => {
    useReindexProgressStore.getState().setProgress({
      sceneIndex: 3,
      sceneId: "s-3",
      totalScenes: 10,
      chunksIndexed: 12,
      done: false,
    });
    const s = useReindexProgressStore.getState();
    expect(s.active).toBe(true);
    expect(s.finished).toBe(false);
    expect(s.current).toEqual({
      sceneIndex: 3,
      sceneId: "s-3",
      totalScenes: 10,
      chunksIndexed: 12,
      done: false,
    });
  });

  it("setProgress with done=true marks finished and schedules auto clear", () => {
    useReindexProgressStore.getState().setProgress({
      sceneIndex: 10,
      sceneId: "s-10",
      totalScenes: 10,
      chunksIndexed: 50,
      done: true,
    });
    expect(useReindexProgressStore.getState().finished).toBe(true);
    expect(useReindexProgressStore.getState().active).toBe(true);

    // AUTO_CLEAR_MS 経過前は active のまま
    vi.advanceTimersByTime(AUTO_CLEAR_MS - 1);
    expect(useReindexProgressStore.getState().active).toBe(true);
    // 満了で消える
    vi.advanceTimersByTime(1);
    const s = useReindexProgressStore.getState();
    expect(s.active).toBe(false);
    expect(s.current).toBeNull();
    expect(s.finished).toBe(false);
  });

  it("a later non-done progress cancels the previous auto-clear timer", () => {
    // 1 度 done=true で auto-clear を発火させかける
    useReindexProgressStore.getState().setProgress({
      sceneIndex: 5,
      sceneId: "s-5",
      totalScenes: 5,
      chunksIndexed: 25,
      done: true,
    });
    vi.advanceTimersByTime(AUTO_CLEAR_MS - 100);

    // 直後に別の reindex_all が走って done=false の progress を投入
    useReindexProgressStore.getState().setProgress({
      sceneIndex: 1,
      sceneId: "s-other-1",
      totalScenes: 3,
      chunksIndexed: 4,
      done: false,
    });

    // 元のタイマーは破棄されているので、AUTO_CLEAR_MS 経っても消えない
    vi.advanceTimersByTime(AUTO_CLEAR_MS);
    const s = useReindexProgressStore.getState();
    expect(s.active).toBe(true);
    expect(s.finished).toBe(false);
    expect(s.current?.sceneId).toBe("s-other-1");
  });

  it("clear immediately resets state and timer", () => {
    useReindexProgressStore.getState().setProgress({
      sceneIndex: 2,
      sceneId: "s-2",
      totalScenes: 4,
      chunksIndexed: 8,
      done: true,
    });
    useReindexProgressStore.getState().clear();
    expect(useReindexProgressStore.getState().active).toBe(false);
    // タイマーが残っていれば後続で消えるが、既に空なので変化しないはず
    vi.advanceTimersByTime(AUTO_CLEAR_MS * 2);
    expect(useReindexProgressStore.getState().active).toBe(false);
  });
});
