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
    expect(s.activeWorkspaceKey).toBeNull();
    expect(s.activeWorkspaceOpenRevision).toBeNull();
    expect(s.activeProjectId).toBeNull();
    expect(s.activeRunId).toBeNull();
  });

  it("begin/finish only mutate the matching run token", () => {
    const store = useReindexProgressStore.getState();
    expect(store.begin("/workspace/a", 1, "p1", "run-a")).toBe(true);
    expect(useReindexProgressStore.getState().running).toBe(true);
    expect(useReindexProgressStore.getState().activeRunId).toBe("run-a");

    useReindexProgressStore.getState().finish("run-old");
    expect(useReindexProgressStore.getState().running).toBe(true);

    useReindexProgressStore.getState().finish("run-a");
    expect(useReindexProgressStore.getState().running).toBe(false);
  });

  it("keeps the token after invoke finish so a delayed done event is accepted", () => {
    const store = useReindexProgressStore.getState();
    expect(store.begin("/workspace/a", 1, "p1", "run-fast")).toBe(true);
    store.finish("run-fast");
    expect(useReindexProgressStore.getState().activeRunId).toBe("run-fast");

    useReindexProgressStore.getState().setProgress({
      projectId: "p1",
      runId: "run-fast",
      sceneIndex: 0,
      sceneId: "",
      totalScenes: 0,
      chunksIndexed: 0,
      done: true,
    });
    expect(useReindexProgressStore.getState().finished).toBe(true);
    vi.advanceTimersByTime(AUTO_CLEAR_MS);
    expect(useReindexProgressStore.getState().activeRunId).toBeNull();
  });

  it("an old run failure cannot clear a newer workspace run", () => {
    const store = useReindexProgressStore.getState();
    expect(store.begin("/workspace/a", 1, "default-project", "run-a")).toBe(
      true,
    );
    store.clear();
    expect(
      useReindexProgressStore
        .getState()
        .begin("/workspace/b", 2, "default-project", "run-b"),
    ).toBe(true);
    useReindexProgressStore.getState().setProgress({
      projectId: "default-project",
      runId: "run-b",
      sceneIndex: 1,
      sceneId: "b-scene",
      totalScenes: 2,
      chunksIndexed: 4,
      done: false,
    });

    useReindexProgressStore.getState().fail("run-a");
    const current = useReindexProgressStore.getState();
    expect(current.running).toBe(true);
    expect(current.activeRunId).toBe("run-b");
    expect(current.current?.sceneId).toBe("b-scene");
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
    useReindexProgressStore.getState().begin("/workspace/a", 1, "p1", "run-a");
    useReindexProgressStore.getState().setProgress({
      sceneIndex: 2,
      sceneId: "s-2",
      totalScenes: 4,
      chunksIndexed: 8,
      done: true,
    });
    useReindexProgressStore.getState().clear();
    expect(useReindexProgressStore.getState()).toMatchObject({
      active: false,
      running: false,
      activeWorkspaceKey: null,
      activeWorkspaceOpenRevision: null,
      activeProjectId: null,
      activeRunId: null,
    });
    // タイマーが残っていれば後続で消えるが、既に空なので変化しないはず
    vi.advanceTimersByTime(AUTO_CLEAR_MS * 2);
    expect(useReindexProgressStore.getState().active).toBe(false);
  });
});
