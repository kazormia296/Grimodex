import { describe, it, expect, beforeEach } from "vitest";
import { useGlobalHistoryStore } from "./globalHistoryStore";

describe("useGlobalHistoryStore", () => {
  beforeEach(() => {
    useGlobalHistoryStore.getState().clear();
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
});
