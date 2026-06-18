import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@/lib/tauri";
const mockInvoke = vi.mocked(invoke);

import {
  scheduleSceneIndex,
  cancelSceneIndex,
  scheduleCodexIndex,
  cancelCodexIndex,
  _resetSchedulerForTests,
  _pendingCount,
} from "./scheduler";

const DEBOUNCE_MS = 2500;

describe("semantic-search/scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(0);
    _resetSchedulerForTests();
  });

  afterEach(() => {
    _resetSchedulerForTests();
    vi.useRealTimers();
  });

  it("does not call semantic_index_scene before the debounce elapses", () => {
    scheduleSceneIndex("scene-1");
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("fires semantic_index_scene once after the debounce elapses", () => {
    scheduleSceneIndex("scene-1");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("semantic_index_scene", {
      sceneId: "scene-1",
    });
  });

  it("coalesces rapid re-schedules of the same scene into a single fire", () => {
    scheduleSceneIndex("scene-1");
    vi.advanceTimersByTime(1000);
    scheduleSceneIndex("scene-1");
    vi.advanceTimersByTime(1000);
    scheduleSceneIndex("scene-1");
    // ここで合計 2000ms 経過、最後の schedule から 0ms。
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(mockInvoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("debounces per scene_id independently", () => {
    scheduleSceneIndex("scene-1");
    vi.advanceTimersByTime(1000);
    scheduleSceneIndex("scene-2");
    vi.advanceTimersByTime(DEBOUNCE_MS - 1000); // scene-1 だけ満了
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("semantic_index_scene", {
      sceneId: "scene-1",
    });
    vi.advanceTimersByTime(1000); // scene-2 もそろそろ満了
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke).toHaveBeenLastCalledWith("semantic_index_scene", {
      sceneId: "scene-2",
    });
  });

  it("cancelSceneIndex prevents the pending fire", () => {
    scheduleSceneIndex("scene-1");
    cancelSceneIndex("scene-1");
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("cancelSceneIndex on unknown id is a no-op", () => {
    expect(() => cancelSceneIndex("nope")).not.toThrow();
  });

  it("ignores empty sceneId", () => {
    scheduleSceneIndex("");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(_pendingCount()).toBe(0);
  });

  it("tracks pending timer count and clears on fire", () => {
    scheduleSceneIndex("scene-1");
    scheduleSceneIndex("scene-2");
    expect(_pendingCount()).toBe(2);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(_pendingCount()).toBe(0);
  });

  it("does not propagate invoke rejection", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("model not found"));
    scheduleSceneIndex("scene-1");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    // タイマー満了直後、Promise の catch がぶら下がっているだけ。
    // unhandled rejection 警告が出ないことを vi.useRealTimers() の前に確認できれば十分。
    // microtask を flush して catch を走らせる。
    await vi.runAllTimersAsync();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  // ── codex scheduler (段階3, scene 版と同型) ──────────────────────
  it("fires codex_index_entry once after the debounce elapses", () => {
    scheduleCodexIndex("codex-1");
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(mockInvoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("codex_index_entry", {
      entryId: "codex-1",
    });
  });

  it("coalesces rapid re-schedules of the same codex entry", () => {
    scheduleCodexIndex("codex-1");
    vi.advanceTimersByTime(1000);
    scheduleCodexIndex("codex-1");
    vi.advanceTimersByTime(DEBOUNCE_MS - 1);
    expect(mockInvoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("cancelCodexIndex prevents the pending fire", () => {
    scheduleCodexIndex("codex-1");
    cancelCodexIndex("codex-1");
    vi.advanceTimersByTime(DEBOUNCE_MS * 2);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("ignores empty entryId", () => {
    scheduleCodexIndex("");
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(_pendingCount()).toBe(0);
  });

  it("scene and codex timers are tracked independently", () => {
    scheduleSceneIndex("scene-1");
    scheduleCodexIndex("codex-1");
    expect(_pendingCount()).toBe(2);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(_pendingCount()).toBe(0);
    expect(mockInvoke).toHaveBeenCalledWith("semantic_index_scene", {
      sceneId: "scene-1",
    });
    expect(mockInvoke).toHaveBeenCalledWith("codex_index_entry", {
      entryId: "codex-1",
    });
  });
});
