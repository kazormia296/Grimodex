import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  useGlobalHistoryStore,
  setHistoryReplayGuard,
} from "./globalHistoryStore";

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
    it("collapses multiple pushes during the callback into a single history entry", async () => {
      await useGlobalHistoryStore
        .getState()
        .runAsTransaction({ kind: "plot", label: "複合操作" }, async () => {
          useGlobalHistoryStore.getState().push({
            kind: "plot",
            label: "step-1",
            undo: async () => {},
            redo: async () => {},
          });
          useGlobalHistoryStore.getState().push({
            kind: "plot",
            label: "step-2",
            undo: async () => {},
            redo: async () => {},
          });
        });
      const s = useGlobalHistoryStore.getState();
      expect(s.past).toHaveLength(1);
      expect(s.past[0].label).toBe("複合操作");
      expect(s.canUndo).toBe(true);
    });

    it("undo runs collected undos in reverse order; redo runs them forward", async () => {
      const order: string[] = [];
      await useGlobalHistoryStore
        .getState()
        .runAsTransaction({ kind: "plot", label: "複合" }, async () => {
          useGlobalHistoryStore.getState().push({
            kind: "plot",
            label: "a",
            undo: async () => {
              order.push("undo-a");
            },
            redo: async () => {
              order.push("redo-a");
            },
          });
          useGlobalHistoryStore.getState().push({
            kind: "plot",
            label: "b",
            undo: async () => {
              order.push("undo-b");
            },
            redo: async () => {
              order.push("redo-b");
            },
          });
        });
      await useGlobalHistoryStore.getState().undo();
      await useGlobalHistoryStore.getState().redo();
      // undo reverses (b then a); redo replays forward (a then b).
      expect(order).toEqual(["undo-b", "undo-a", "redo-a", "redo-b"]);
    });

    it("a single push inside a transaction still produces one entry labelled by the transaction", async () => {
      await useGlobalHistoryStore
        .getState()
        .runAsTransaction({ kind: "plot", label: "単一" }, async () => {
          useGlobalHistoryStore.getState().push({
            kind: "plot",
            label: "inner",
            undo: async () => {},
            redo: async () => {},
          });
        });
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

    it("nested transactions flatten into the outer entry", async () => {
      await useGlobalHistoryStore
        .getState()
        .runAsTransaction({ kind: "plot", label: "outer" }, async () => {
          useGlobalHistoryStore.getState().push({
            kind: "plot",
            label: "x",
            undo: async () => {},
            redo: async () => {},
          });
          await useGlobalHistoryStore
            .getState()
            .runAsTransaction({ kind: "plot", label: "inner" }, async () => {
              useGlobalHistoryStore.getState().push({
                kind: "plot",
                label: "y",
                undo: async () => {},
                redo: async () => {},
              });
            });
        });
      const s = useGlobalHistoryStore.getState();
      expect(s.past).toHaveLength(1);
      expect(s.past[0].label).toBe("outer");
    });
  });
});
