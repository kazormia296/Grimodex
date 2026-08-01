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
    vi.unstubAllGlobals();
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

    await vi.advanceTimersByTimeAsync(17);
    expect(runs).toEqual(["latest-save", "lint"]);
    expect(_pendingEditorAnalysisTaskCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts simultaneous due tasks on separate ticks in priority order", async () => {
    const runs: string[] = [];
    const schedule = (task: {
      key: string;
      kind: "save" | "codex-match" | "lint" | "derived" | "semantic";
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
    schedule({ key: "derived:scene-1", kind: "derived" });
    schedule({ key: "lint:scene-1", kind: "lint" });
    schedule({ key: "codex-match:scene-1", kind: "codex-match" });
    schedule({ key: "autosave:scene-1", kind: "save" });
    expect(_pendingEditorAnalysisTaskCount()).toBe(5);

    await vi.advanceTimersByTimeAsync(50);
    expect(runs).toEqual(["save"]);

    await vi.advanceTimersByTimeAsync(17);
    expect(runs).toEqual(["save", "codex-match"]);

    await vi.advanceTimersByTimeAsync(17);
    expect(runs).toEqual(["save", "codex-match", "lint"]);

    await vi.advanceTimersByTimeAsync(17);
    expect(runs).toEqual(["save", "codex-match", "lint", "derived"]);

    await vi.advanceTimersByTimeAsync(17);
    expect(runs).toEqual([
      "save",
      "codex-match",
      "lint",
      "derived",
      "semantic",
    ]);
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

    await vi.advanceTimersByTimeAsync(17);
    expect(runs).toEqual(["save", "codex-match"]);
    await vi.advanceTimersByTimeAsync(17);
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
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(17);
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

    await vi.advanceTimersByTimeAsync(17);
    expect(runs).toEqual(["lint"]);
  });

  it("lets a newly due durable save preempt a waiting background task", async () => {
    const runs: string[] = [];

    scheduleEditorAnalysisTask({
      key: "lint:waiting",
      kind: "lint",
      delayMs: 0,
      run: () => {
        runs.push("lint");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual([]);

    scheduleEditorAnalysisTask({
      key: "save:critical",
      kind: "save",
      delayMs: 0,
      run: () => {
        runs.push("save");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual(["save"]);

    await vi.advanceTimersByTimeAsync(17);
    expect(runs).toEqual(["save", "lint"]);
  });

  it("holds background work until an in-flight durable save settles", async () => {
    const runs: string[] = [];
    let finishSave: () => void = () => {
      throw new Error("save did not start");
    };

    scheduleEditorAnalysisTask({
      key: "save:in-flight",
      kind: "save",
      delayMs: 0,
      run: () =>
        new Promise<void>((resolve) => {
          runs.push("save-start");
          finishSave = () => {
            runs.push("save-end");
            resolve();
          };
        }),
    });
    scheduleEditorAnalysisTask({
      key: "lint:after-save",
      kind: "lint",
      delayMs: 0,
      run: () => {
        runs.push("lint");
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toEqual(["save-start"]);

    finishSave();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(17);
    expect(runs).toEqual(["save-start", "save-end", "lint"]);
  });

  it("moves ready background work behind a future durable save", async () => {
    const runs: string[] = [];

    scheduleEditorAnalysisTask({
      key: "lint:ready",
      kind: "lint",
      delayMs: 0,
      run: () => {
        runs.push("lint");
      },
    });
    scheduleEditorAnalysisTask({
      key: "save:soon",
      kind: "save",
      delayMs: 50,
      run: () => {
        runs.push("save");
      },
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(["save"]);
    await vi.advanceTimersByTimeAsync(17);
    expect(runs).toEqual(["save", "lint"]);
  });

  it("keeps codex highlight latency independent of a future autosave", async () => {
    const runs: string[] = [];
    const postTask = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal("scheduler", { postTask });

    scheduleEditorAnalysisTask({
      key: "codex-match:scene-1",
      kind: "codex-match",
      delayMs: 150,
      run: () => {
        runs.push("codex-match");
      },
    });
    scheduleEditorAnalysisTask({
      key: "autosave:scene-1",
      kind: "save",
      delayMs: 2_000,
      run: () => {
        runs.push("save");
      },
    });

    await vi.advanceTimersByTimeAsync(149);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(18);
    expect(runs).toEqual(["codex-match"]);
    expect(postTask).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_833);
    expect(runs).toEqual(["codex-match", "save"]);
  });

  it("falls back once when an accepted background postTask is starved", async () => {
    const run = vi.fn();
    const postTask = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal("scheduler", { postTask });

    scheduleEditorAnalysisTask({
      key: "revision:starved",
      kind: "revision",
      delayMs: 0,
      run,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(postTask).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledOnce();
  });
});
