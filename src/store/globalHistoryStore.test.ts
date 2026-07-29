import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useGlobalHistoryStore,
  setHistoryReplayGuard,
} from "./globalHistoryStore";
import { PhaseVersionConflictError } from "@/features/codex/phaseOcc";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";
import { flushQuiescenceProviderStage } from "@/lib/quiescenceProviders";
import { IpcInvokeError } from "@/lib/tauri";

describe("useGlobalHistoryStore", () => {
  beforeEach(() => {
    _resetQuiescenceLeasesForTests();
    useGlobalHistoryStore.getState().clear();
  });

  afterEach(() => {
    _resetQuiescenceLeasesForTests();
  });

  it("starts empty with canUndo / canRedo false", () => {
    const s = useGlobalHistoryStore.getState();
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(false);
    expect(s.isReplaying).toBe(false);
  });

  it("push appends and enables canUndo, clears future", () => {
    const cmd = {
      kind: "scenes" as const,
      label: "テスト",
      undo: async () => {},
      redo: async () => {},
    };
    useGlobalHistoryStore.getState().push(cmd);
    const s = useGlobalHistoryStore.getState();
    expect(s.past).toHaveLength(1);
    expect(s.future).toEqual([]);
    expect(s.canUndo).toBe(true);
    expect(s.canRedo).toBe(false);
  });

  it("deduplicates a retried backend operation across both history stacks", async () => {
    const original = {
      kind: "codex" as const,
      label: "original",
      operationId: "undo-journal-1",
      undo: async () => {},
      redo: async () => {},
    };
    useGlobalHistoryStore.getState().push(original);
    useGlobalHistoryStore.getState().push({
      ...original,
      label: "retried response",
    });
    expect(useGlobalHistoryStore.getState().past).toEqual([original]);

    await useGlobalHistoryStore.getState().undo();

    useGlobalHistoryStore.getState().push({
      ...original,
      label: "retried response",
    });

    const state = useGlobalHistoryStore.getState();
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([original]);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(true);
  });

  it("keeps an evicted operation id seen for delayed retries", () => {
    const original = {
      kind: "codex" as const,
      label: "original",
      operationId: "undo-journal-evicted",
      undo: async () => {},
      redo: async () => {},
    };
    useGlobalHistoryStore.getState().push(original);
    for (let i = 0; i < 50; i++) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: `later-${i}`,
        undo: async () => {},
        redo: async () => {},
      });
    }
    expect(useGlobalHistoryStore.getState().past).not.toContain(original);

    useGlobalHistoryStore.getState().push({
      ...original,
      label: "delayed retry",
    });

    expect(useGlobalHistoryStore.getState().past).toHaveLength(50);
    expect(
      useGlobalHistoryStore
        .getState()
        .past.some((entry) => entry.label === "delayed retry"),
    ).toBe(false);
  });

  it("keeps an invalidated operation id seen for delayed retries", () => {
    const original = {
      kind: "codex" as const,
      label: "original",
      operationId: "undo-journal-invalidated",
      entityId: "codex-1",
      undo: async () => {},
      redo: async () => {},
    };
    useGlobalHistoryStore.getState().push(original);
    useGlobalHistoryStore.getState().invalidateForEntity("codex", "codex-1");
    expect(useGlobalHistoryStore.getState().past).toEqual([]);

    useGlobalHistoryStore.getState().push({
      ...original,
      label: "delayed retry",
    });

    expect(useGlobalHistoryStore.getState().past).toEqual([]);
  });

  it.each([
    ["chronicle", "event-1"],
    ["scenes", "scene-1"],
  ] as const)(
    "invalidating an affected %s entity drops the whole composite command",
    (kind, entityId) => {
      const bulk = {
        kind: "chronicle" as const,
        label: "mixed Chronicle edit",
        affectedEntities: [
          { kind: "chronicle" as const, entityId: "event-1" },
          { kind: "scenes" as const, entityId: "scene-1" },
        ],
        undo: async () => {},
        redo: async () => {},
      };
      const unrelated = {
        kind: "chronicle" as const,
        label: "unrelated",
        entityId: "event-other",
        undo: async () => {},
        redo: async () => {},
      };
      useGlobalHistoryStore.getState().push(bulk);
      useGlobalHistoryStore.getState().push(unrelated);

      useGlobalHistoryStore.getState().invalidateForEntity(kind, entityId);

      expect(useGlobalHistoryStore.getState().past).toEqual([unrelated]);
    },
  );

  it("clear resets operation ids for the next project/session", () => {
    const command = {
      kind: "codex" as const,
      label: "project A",
      operationId: "project-local-operation",
      undo: async () => {},
      redo: async () => {},
    };
    useGlobalHistoryStore.getState().push(command);
    useGlobalHistoryStore.getState().clear();
    useGlobalHistoryStore.getState().push({
      ...command,
      label: "project B",
    });

    expect(useGlobalHistoryStore.getState().past).toHaveLength(1);
    expect(useGlobalHistoryStore.getState().past[0].label).toBe("project B");
  });

  it("push trims past to max size 50", () => {
    for (let i = 0; i < 60; i++) {
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: `op-${i}`,
        undo: async () => {},
        redo: async () => {},
      });
    }
    const s = useGlobalHistoryStore.getState();
    expect(s.past).toHaveLength(50);
    expect(s.past[0].label).toBe("op-10");
    expect(s.past[49].label).toBe("op-59");
  });

  it("undo invokes the cmd.undo and moves entry to future", async () => {
    let undoCalled = false;
    useGlobalHistoryStore.getState().push({
      kind: "codex",
      label: "X",
      undo: async () => {
        undoCalled = true;
      },
      redo: async () => {},
    });
    await useGlobalHistoryStore.getState().undo();
    const s = useGlobalHistoryStore.getState();
    expect(undoCalled).toBe(true);
    expect(s.past).toHaveLength(0);
    expect(s.future).toHaveLength(1);
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(true);
  });

  it("redo invokes the cmd.redo and moves entry to past", async () => {
    let redoCalled = false;
    useGlobalHistoryStore.getState().push({
      kind: "codex",
      label: "X",
      undo: async () => {},
      redo: async () => {
        redoCalled = true;
      },
    });
    await useGlobalHistoryStore.getState().undo();
    await useGlobalHistoryStore.getState().redo();
    const s = useGlobalHistoryStore.getState();
    expect(redoCalled).toBe(true);
    expect(s.past).toHaveLength(1);
    expect(s.future).toHaveLength(0);
  });

  it("isReplaying flag is true during undo", async () => {
    let observedReplaying = false;
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "X",
      undo: async () => {
        observedReplaying = useGlobalHistoryStore.getState().isReplaying;
      },
      redo: async () => {},
    });
    await useGlobalHistoryStore.getState().undo();
    expect(observedReplaying).toBe(true);
    expect(useGlobalHistoryStore.getState().isReplaying).toBe(false);
  });

  it("undo throwing clears history and rethrows", async () => {
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "X",
      undo: async () => {
        throw new Error("boom");
      },
      redo: async () => {},
    });
    await expect(useGlobalHistoryStore.getState().undo()).rejects.toThrow(
      "boom",
    );
    const s = useGlobalHistoryStore.getState();
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
    expect(s.isReplaying).toBe(false);
  });

  it("keeps the undo command reachable after an unknown IPC outcome", async () => {
    let undoCalls = 0;
    const unknown = new IpcInvokeError("plot_thread_restore_snapshot", {
      code: "IPC_TIMEOUT",
      message: "native outcome is unknown",
      retryable: true,
      outcome: "unknown",
    });
    const command = {
      kind: "plot" as const,
      label: "restore plot snapshot",
      undo: async () => {
        undoCalls++;
        if (undoCalls === 1) throw unknown;
      },
      redo: async () => {},
    };
    useGlobalHistoryStore.getState().push(command);

    await expect(useGlobalHistoryStore.getState().undo()).rejects.toBe(unknown);

    let state = useGlobalHistoryStore.getState();
    expect(state.past).toEqual([command]);
    expect(state.future).toEqual([]);
    expect(state.canUndo).toBe(true);
    expect(state.canRedo).toBe(false);
    expect(state.isReplaying).toBe(false);

    await useGlobalHistoryStore.getState().undo();

    state = useGlobalHistoryStore.getState();
    expect(undoCalls).toBe(2);
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([command]);
  });

  it("version conflict on undo drops only the failed entry and keeps history", async () => {
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "keep-me",
      undo: async () => {},
      redo: async () => {},
    });
    useGlobalHistoryStore.getState().push({
      kind: "codex",
      label: "stale",
      entityId: "entry-1",
      undo: async () => {
        throw new Error(
          "codex entry 'entry-1' version 2 conflict during journal restore",
        );
      },
      redo: async () => {},
    });
    await useGlobalHistoryStore.getState().undo();
    const s = useGlobalHistoryStore.getState();
    expect(s.past).toHaveLength(1);
    expect(s.past[0].label).toBe("keep-me");
    expect(s.future).toEqual([]);
    expect(s.canUndo).toBe(true);
  });

  it("version conflict on redo drops only the failed entry", async () => {
    useGlobalHistoryStore.getState().push({
      kind: "codex",
      label: "stale",
      entityId: "entry-2",
      undo: async () => {},
      redo: async () => {
        throw new Error(
          "Codex entry 'entry-2' version conflict: expected 1 but database has 3",
        );
      },
    });
    await useGlobalHistoryStore.getState().undo();
    await useGlobalHistoryStore.getState().redo();
    const s = useGlobalHistoryStore.getState();
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
    expect(s.canRedo).toBe(false);
  });

  it("retains an opted-in Phase command on the undo stack after a version conflict", async () => {
    const command = {
      kind: "phase" as const,
      label: "stale phase",
      entityId: "phase-1",
      documentKey: {
        kind: "codex" as const,
        id: "entry-1",
        phaseId: "phase-1",
      },
      retainOnVersionConflict: true,
      undo: async () => {
        throw new PhaseVersionConflictError("phase-1");
      },
      redo: async () => {},
    };
    useGlobalHistoryStore.getState().push(command);

    await useGlobalHistoryStore.getState().undo();

    const state = useGlobalHistoryStore.getState();
    expect(state.past).toEqual([command]);
    expect(state.future).toEqual([]);
    expect(state.canUndo).toBe(true);
    expect(state.canRedo).toBe(false);
    expect(state.isReplaying).toBe(false);
  });

  it("retains an opted-in Phase command on the redo stack after a version conflict", async () => {
    const command = {
      kind: "phase" as const,
      label: "stale phase",
      entityId: "phase-1",
      documentKey: {
        kind: "codex" as const,
        id: "entry-1",
        phaseId: "phase-1",
      },
      retainOnVersionConflict: true,
      undo: async () => {},
      redo: async () => {
        throw new PhaseVersionConflictError("phase-1");
      },
    };
    useGlobalHistoryStore.getState().push(command);
    await useGlobalHistoryStore.getState().undo();

    await useGlobalHistoryStore.getState().redo();

    const state = useGlobalHistoryStore.getState();
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([command]);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(true);
    expect(state.isReplaying).toBe(false);
  });

  it("redo throwing clears history and rethrows", async () => {
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "X",
      undo: async () => {},
      redo: async () => {
        throw new Error("boom");
      },
    });
    await useGlobalHistoryStore.getState().undo();
    await expect(useGlobalHistoryStore.getState().redo()).rejects.toThrow(
      "boom",
    );
    const s = useGlobalHistoryStore.getState();
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
  });

  it("keeps the redo command reachable after an unknown IPC outcome", async () => {
    let redoCalls = 0;
    const unknown = new IpcInvokeError("plot_thread_restore_snapshot", {
      code: "IPC_TIMEOUT",
      message: "native outcome is unknown",
      retryable: true,
      outcome: "unknown",
    });
    const command = {
      kind: "plot" as const,
      label: "restore plot snapshot",
      undo: async () => {},
      redo: async () => {
        redoCalls++;
        if (redoCalls === 1) throw unknown;
      },
    };
    useGlobalHistoryStore.getState().push(command);
    await useGlobalHistoryStore.getState().undo();

    await expect(useGlobalHistoryStore.getState().redo()).rejects.toBe(unknown);

    let state = useGlobalHistoryStore.getState();
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([command]);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(true);
    expect(state.isReplaying).toBe(false);

    await useGlobalHistoryStore.getState().redo();

    state = useGlobalHistoryStore.getState();
    expect(redoCalls).toBe(2);
    expect(state.past).toEqual([command]);
    expect(state.future).toEqual([]);
  });

  it("undo while already replaying is a no-op", async () => {
    let undoCount = 0;
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "X",
      undo: async () => {
        undoCount++;
        // Try to call undo again from inside undo — should be ignored
        await useGlobalHistoryStore.getState().undo();
      },
      redo: async () => {},
    });
    await useGlobalHistoryStore.getState().undo();
    expect(undoCount).toBe(1);
  });

  it("push is a no-op while replaying", async () => {
    let observedFutureLen = -1;
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "outer",
      undo: async () => {
        // Misbehaving inner code tries to push during undo; should be ignored
        // by the safety net even if a call site forgets to guard.
        useGlobalHistoryStore.getState().push({
          kind: "scenes",
          label: "inner",
          undo: async () => {},
          redo: async () => {},
        });
        observedFutureLen = useGlobalHistoryStore.getState().future.length;
      },
      redo: async () => {},
    });
    await useGlobalHistoryStore.getState().undo();
    const s = useGlobalHistoryStore.getState();
    // The inner push was ignored, so future contains exactly the outer cmd
    expect(s.past).toHaveLength(0);
    expect(s.future).toHaveLength(1);
    expect(s.future[0].label).toBe("outer");
    // While replaying, future was still empty (push had not yet appended outer
    // to future and the inner push was rejected outright).
    expect(observedFutureLen).toBe(0);
  });

  it("does not resurrect an undo command invalidated while replay is in flight", async () => {
    const keep = {
      kind: "scenes" as const,
      label: "keep",
      entityId: "scene-keep",
      undo: async () => {},
      redo: async () => {},
    };
    let releaseUndo!: () => void;
    const undoGate = new Promise<void>((resolve) => {
      releaseUndo = resolve;
    });
    const invalidated = {
      kind: "codex" as const,
      label: "invalidated",
      entityId: "codex-invalidated",
      undo: () => undoGate,
      redo: async () => {},
    };
    useGlobalHistoryStore.getState().push(keep);
    useGlobalHistoryStore.getState().push(invalidated);

    const undoing = useGlobalHistoryStore.getState().undo();
    expect(useGlobalHistoryStore.getState().isReplaying).toBe(true);
    useGlobalHistoryStore
      .getState()
      .invalidateForEntity("codex", "codex-invalidated");
    expect(useGlobalHistoryStore.getState().past).toEqual([keep]);

    releaseUndo();
    await undoing;

    const state = useGlobalHistoryStore.getState();
    expect(state.past).toEqual([keep]);
    expect(state.future).toEqual([]);
    expect(state.canUndo).toBe(true);
    expect(state.canRedo).toBe(false);
    expect(state.isReplaying).toBe(false);
  });

  it("does not resurrect a redo command invalidated while replay is in flight", async () => {
    const keep = {
      kind: "scenes" as const,
      label: "keep",
      entityId: "scene-keep",
      undo: async () => {},
      redo: async () => {},
    };
    let releaseRedo!: () => void;
    const redoGate = new Promise<void>((resolve) => {
      releaseRedo = resolve;
    });
    const invalidated = {
      kind: "codex" as const,
      label: "invalidated",
      entityId: "codex-invalidated",
      undo: async () => {},
      redo: () => redoGate,
    };
    useGlobalHistoryStore.getState().push(keep);
    useGlobalHistoryStore.getState().push(invalidated);
    await useGlobalHistoryStore.getState().undo();

    const redoing = useGlobalHistoryStore.getState().redo();
    expect(useGlobalHistoryStore.getState().isReplaying).toBe(true);
    useGlobalHistoryStore
      .getState()
      .invalidateForEntity("codex", "codex-invalidated");
    expect(useGlobalHistoryStore.getState().future).toEqual([]);

    releaseRedo();
    await redoing;

    const state = useGlobalHistoryStore.getState();
    expect(state.past).toEqual([keep]);
    expect(state.future).toEqual([]);
    expect(state.canUndo).toBe(true);
    expect(state.canRedo).toBe(false);
    expect(state.isReplaying).toBe(false);
  });

  it("keeps both history stacks unchanged while a lifecycle lease is active", async () => {
    let firstUndoCalls = 0;
    let secondRedoCalls = 0;
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "first",
      undo: async () => {
        firstUndoCalls++;
      },
      redo: async () => {},
    });
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "second",
      undo: async () => {},
      redo: async () => {
        secondRedoCalls++;
      },
    });
    await useGlobalHistoryStore.getState().undo();
    const before = useGlobalHistoryStore.getState();
    const lease = acquireQuiescenceLease("workspace-open");

    await useGlobalHistoryStore.getState().undo();
    await useGlobalHistoryStore.getState().redo();

    const after = useGlobalHistoryStore.getState();
    expect(firstUndoCalls).toBe(0);
    expect(secondRedoCalls).toBe(0);
    expect(after.past).toEqual(before.past);
    expect(after.future).toEqual(before.future);
    expect(after.canUndo).toBe(before.canUndo);
    expect(after.canRedo).toBe(before.canRedo);
    expect(after.isReplaying).toBe(false);
    lease.release();
  });

  it("exposes an in-flight replay to strict quiescence", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "slow undo",
      undo: () => gate,
      redo: async () => {},
    });

    const undoing = useGlobalHistoryStore.getState().undo();
    let flushed = false;
    const flushing = flushQuiescenceProviderStage("scoped-mutations").then(
      () => {
        flushed = true;
      },
    );
    await Promise.resolve();
    expect(flushed).toBe(false);

    release();
    await Promise.all([undoing, flushing]);
    expect(flushed).toBe(true);
  });

  it("does not start a new compound transaction under a lifecycle lease", async () => {
    const operation = vi.fn(async () => {});
    acquireQuiescenceLease("window-close");

    await useGlobalHistoryStore
      .getState()
      .runAsTransaction({ kind: "plot", label: "blocked import" }, operation);

    expect(operation).not.toHaveBeenCalled();
    expect(useGlobalHistoryStore.getState().past).toEqual([]);
    expect(useGlobalHistoryStore.getState().future).toEqual([]);
  });

  it("clear removes both past and future and resets canUndo/canRedo", async () => {
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "X",
      undo: async () => {},
      redo: async () => {},
    });
    await useGlobalHistoryStore.getState().undo();
    useGlobalHistoryStore.getState().clear();
    const s = useGlobalHistoryStore.getState();
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(false);
  });

  describe("replay guard (inline-AI pending veto)", () => {
    afterEach(() => setHistoryReplayGuard(null));

    it("vetoes undo without running cmd.undo when the guard returns true", async () => {
      let undoCalled = false;
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: "X",
        undo: async () => {
          undoCalled = true;
        },
        redo: async () => {},
      });
      setHistoryReplayGuard(() => true);
      await useGlobalHistoryStore.getState().undo();
      expect(undoCalled).toBe(false);
      // History is untouched — the entry stays in past for later replay.
      expect(useGlobalHistoryStore.getState().past).toHaveLength(1);
    });

    it("vetoes redo without running cmd.redo when the guard returns true", async () => {
      let redoCalled = false;
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: "X",
        undo: async () => {},
        redo: async () => {
          redoCalled = true;
        },
      });
      await useGlobalHistoryStore.getState().undo(); // move to future
      setHistoryReplayGuard(() => true);
      await useGlobalHistoryStore.getState().redo();
      expect(redoCalled).toBe(false);
      expect(useGlobalHistoryStore.getState().future).toHaveLength(1);
    });

    it("does not fire the guard when there is nothing to undo", () => {
      let calls = 0;
      setHistoryReplayGuard(() => {
        calls++;
        return true;
      });
      void useGlobalHistoryStore.getState().undo();
      expect(calls).toBe(0);
    });

    it("allows undo when the guard returns false", async () => {
      let undoCalled = false;
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: "X",
        undo: async () => {
          undoCalled = true;
        },
        redo: async () => {},
      });
      setHistoryReplayGuard(() => false);
      await useGlobalHistoryStore.getState().undo();
      expect(undoCalled).toBe(true);
    });
  });

  describe("runAsTransaction (batch grouping)", () => {
    it("does not absorb an unrelated push while the transaction awaits", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const transaction = useGlobalHistoryStore
        .getState()
        .runAsTransaction(
          { kind: "plot", label: "plot import" },
          async (collector) => {
            collector.push({
              kind: "plot",
              label: "plot step",
              undo: async () => {},
              redo: async () => {},
            });
            await gate;
          },
        );

      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: "unrelated edit",
        undo: async () => {},
        redo: async () => {},
      });
      release();
      await transaction;

      expect(
        useGlobalHistoryStore.getState().past.map((entry) => entry.label),
      ).toEqual(["unrelated edit", "plot import"]);
    });

    it("collapses multiple pushes during the callback into a single history entry", async () => {
      await useGlobalHistoryStore
        .getState()
        .runAsTransaction(
          { kind: "plot", label: "複合操作" },
          async (collector) => {
            collector.push({
              kind: "plot",
              label: "step-1",
              undo: async () => {},
              redo: async () => {},
            });
            collector.push({
              kind: "plot",
              label: "step-2",
              undo: async () => {},
              redo: async () => {},
            });
          },
        );
      const s = useGlobalHistoryStore.getState();
      expect(s.past).toHaveLength(1);
      expect(s.past[0].label).toBe("複合操作");
      expect(s.canUndo).toBe(true);
    });

    it("deduplicates retried inner operations after a composite is invalidated", async () => {
      await useGlobalHistoryStore
        .getState()
        .runAsTransaction(
          { kind: "plot", label: "import", entityId: "plot-1" },
          async (collector) => {
            collector.push({
              kind: "plot",
              label: "create thread",
              operationId: "plot-create-journal-1",
              undo: async () => {},
              redo: async () => {},
            });
          },
        );
      expect(useGlobalHistoryStore.getState().past[0].operationIds).toEqual([
        "plot-create-journal-1",
      ]);
      useGlobalHistoryStore.getState().invalidateForEntity("plot", "plot-1");

      await useGlobalHistoryStore
        .getState()
        .runAsTransaction(
          { kind: "plot", label: "retried import", entityId: "plot-1" },
          async (collector) => {
            collector.push({
              kind: "plot",
              label: "retried create",
              operationId: "plot-create-journal-1",
              undo: async () => {},
              redo: async () => {},
            });
          },
        );

      expect(useGlobalHistoryStore.getState().past).toEqual([]);
    });

    it("undo runs collected undos in reverse order; redo runs them forward", async () => {
      const order: string[] = [];
      await useGlobalHistoryStore
        .getState()
        .runAsTransaction(
          { kind: "plot", label: "複合" },
          async (collector) => {
            collector.push({
              kind: "plot",
              label: "a",
              undo: async () => {
                order.push("undo-a");
              },
              redo: async () => {
                order.push("redo-a");
              },
            });
            collector.push({
              kind: "plot",
              label: "b",
              undo: async () => {
                order.push("undo-b");
              },
              redo: async () => {
                order.push("redo-b");
              },
            });
          },
        );
      await useGlobalHistoryStore.getState().undo();
      await useGlobalHistoryStore.getState().redo();
      // undo reverses (b then a); redo replays forward (a then b).
      expect(order).toEqual(["undo-b", "undo-a", "redo-a", "redo-b"]);
    });

    it("a single push inside a transaction still produces one entry labelled by the transaction", async () => {
      await useGlobalHistoryStore
        .getState()
        .runAsTransaction(
          { kind: "plot", label: "単一" },
          async (collector) => {
            collector.push({
              kind: "plot",
              label: "inner",
              undo: async () => {},
              redo: async () => {},
            });
          },
        );
      const s = useGlobalHistoryStore.getState();
      expect(s.past).toHaveLength(1);
      expect(s.past[0].label).toBe("単一");
    });

    it("a transaction with no pushes adds nothing to history", async () => {
      await useGlobalHistoryStore
        .getState()
        .runAsTransaction({ kind: "plot", label: "空" }, async () => {});
      const s = useGlobalHistoryStore.getState();
      expect(s.past).toHaveLength(0);
      expect(s.canUndo).toBe(false);
    });

    it("allows nested helpers to share the explicit collector", async () => {
      await useGlobalHistoryStore
        .getState()
        .runAsTransaction(
          { kind: "plot", label: "outer" },
          async (collector) => {
            collector.push({
              kind: "plot",
              label: "x",
              undo: async () => {},
              redo: async () => {},
            });
            await Promise.resolve();
            collector.push({
              kind: "plot",
              label: "y",
              undo: async () => {},
              redo: async () => {},
            });
          },
        );
      const s = useGlobalHistoryStore.getState();
      expect(s.past).toHaveLength(1);
      expect(s.past[0].label).toBe("outer");
    });
  });
});
