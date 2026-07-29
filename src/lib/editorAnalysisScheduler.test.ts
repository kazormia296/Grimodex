import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _pendingEditorAnalysisTaskCount,
  _resetEditorAnalysisSchedulerForTests,
  cancelEditorAnalysisTask,
  scheduleEditorAnalysisTask,
} from "./editorAnalysisScheduler";

describe("editorAnalysisScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetEditorAnalysisSchedulerForTests();
  });

  afterEach(() => {
    _resetEditorAnalysisSchedulerForTests();
    vi.useRealTimers();
  });

  it("owns one timer and latest-coalesces each task key", async () => {
    const runs: string[] = [];

    scheduleEditorAnalysisTask({
      key: "save:scene-1",
      kind: "save",
      delayMs: 100,
      run: () => {
        runs.push("stale-save");
      },
    });
    scheduleEditorAnalysisTask({
      key: "lint:scene-1",
      kind: "lint",
      delayMs: 100,
      run: () => {
        runs.push("lint");
      },
    });
    scheduleEditorAnalysisTask({
      key: "save:scene-1",
      kind: "save",
      delayMs: 100,
      run: () => {
        runs.push("latest-save");
      },
    });

    expect(_pendingEditorAnalysisTaskCount()).toBe(2);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toEqual(["latest-save"]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(["latest-save", "lint"]);
    expect(_pendingEditorAnalysisTaskCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts simultaneous due tasks on separate ticks in priority order", async () => {
    const runs: string[] = [];
    const schedule = (task: {
      key: string;
      kind: "save" | "codex-match" | "lint" | "semantic";
    }) => {
      scheduleEditorAnalysisTask({
        key: task.key,
        kind: task.kind,
        delayMs: 50,
        run: () => {
          runs.push(task.kind);
        },
      });
    };

    // These mirror the four producer namespaces. Sharing an entity suffix
    // must not coalesce tasks owned by different producers.
    schedule({ key: "semantic-scene:scene-1", kind: "semantic" });
    schedule({ key: "lint:scene-1", kind: "lint" });
    schedule({ key: "codex-match:scene-1", kind: "codex-match" });
    schedule({ key: "autosave:scene-1", kind: "save" });
    expect(_pendingEditorAnalysisTaskCount()).toBe(4);

    await vi.advanceTimersByTimeAsync(50);
    expect(runs).toEqual(["save"]);

    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(["save", "codex-match"]);

    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(["save", "codex-match", "lint"]);

    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(["save", "codex-match", "lint", "semantic"]);
  });

  it("keeps the launch spacing when a running task re-enters the scheduler", async () => {
    const runs: string[] = [];

    scheduleEditorAnalysisTask({
      key: "autosave:reentrant",
      kind: "save",
      delayMs: 0,
      run: async () => {
        runs.push("save");
        await Promise.resolve();
        scheduleEditorAnalysisTask({
          key: "lint:reentrant",
          kind: "lint",
          delayMs: 0,
          run: () => {
            runs.push("lint");
          },
        });
      },
    });
    scheduleEditorAnalysisTask({
      key: "codex-match:already-due",
      kind: "codex-match",
      delayMs: 0,
      run: () => {
        runs.push("codex-match");
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual(["save"]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(["save", "codex-match"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(["save", "codex-match", "lint"]);
  });

  it("re-arms the single timer when a task is cancelled or moved later", async () => {
    const runs: string[] = [];

    scheduleEditorAnalysisTask({
      key: "lint:old",
      kind: "lint",
      delayMs: 25,
      run: () => {
        runs.push("old");
      },
    });
    scheduleEditorAnalysisTask({
      key: "semantic:later",
      kind: "semantic",
      delayMs: 100,
      run: () => {
        runs.push("later");
      },
    });
    expect(cancelEditorAnalysisTask("lint:old")).toBe(true);
    expect(cancelEditorAnalysisTask("lint:missing")).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(["later"]);
  });

  it("terminally handles a rejected task and continues draining", async () => {
    const onError = vi.fn();
    const runs: string[] = [];

    scheduleEditorAnalysisTask({
      key: "save:failure",
      kind: "save",
      delayMs: 0,
      run: async () => {
        throw new Error("disk full");
      },
      onError,
    });
    scheduleEditorAnalysisTask({
      key: "lint:after-failure",
      kind: "lint",
      delayMs: 0,
      run: () => {
        runs.push("lint");
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "disk full" }),
    );
    expect(runs).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(["lint"]);
  });
});
