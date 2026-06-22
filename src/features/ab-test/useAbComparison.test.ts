// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// api をモックして DB I/O を切り離す。
const createAbRun = vi.fn();
const setAbRunChosen = vi.fn();
vi.mock("./api", () => ({
  createAbRun: (...args: unknown[]) => createAbRun(...args),
  setAbRunChosen: (...args: unknown[]) => setAbRunChosen(...args),
}));

import { useAbComparison } from "./useAbComparison";
import type { AbDispatcher } from "./abHarness";

const okDispatch: AbDispatcher = async (_messages, config) => ({
  ok: true,
  text: `out:${config.model ?? "default"}`,
});

const BASE = { messages: [{ role: "user", content: "hi" }] };

describe("useAbComparison", () => {
  beforeEach(() => {
    createAbRun.mockReset();
    setAbRunChosen.mockReset();
    createAbRun.mockResolvedValue({ id: "rec-1" });
    setAbRunChosen.mockResolvedValue(undefined);
  });

  it("runs all slots and stores results by id + record id", async () => {
    const { result } = renderHook(() =>
      useAbComparison({
        surface: "chat",
        projectId: "p1",
        dispatch: okDispatch,
      }),
    );

    await act(async () => {
      await result.current.run(BASE, [
        { id: "baseline", config: {} },
        { id: "s2", config: { model: "b" } },
        { id: "s3", config: { provider: "sakana", model: "fugu" } },
      ]);
    });

    expect(result.current.state.results.baseline).toEqual({
      ok: true,
      text: "out:default",
    });
    expect(result.current.state.results.s2).toEqual({
      ok: true,
      text: "out:b",
    });
    expect(result.current.state.results.s3).toEqual({
      ok: true,
      text: "out:fugu",
    });
    expect(result.current.state.recordId).toBe("rec-1");
    expect(createAbRun).toHaveBeenCalledTimes(1);
    const arg = createAbRun.mock.calls[0][0];
    expect(arg).toMatchObject({ projectId: "p1", surface: "chat" });
    expect(arg.slots).toEqual([
      {
        slotId: "baseline",
        provider: null,
        model: null,
        promptVariant: null,
        ok: true,
        response: "out:default",
      },
      {
        slotId: "s2",
        provider: null,
        model: "b",
        promptVariant: null,
        ok: true,
        response: "out:b",
      },
      {
        slotId: "s3",
        provider: "sakana",
        model: "fugu",
        promptVariant: null,
        ok: true,
        response: "out:fugu",
      },
    ]);
  });

  it("does not persist when fewer than two slots succeed", async () => {
    const halfFail: AbDispatcher = async (_messages, config) =>
      config.model === "bad"
        ? { ok: false, error: "boom" }
        : { ok: true, text: "ok" };

    const { result } = renderHook(() =>
      useAbComparison({ surface: "chat", projectId: "p1", dispatch: halfFail }),
    );

    await act(async () => {
      await result.current.run(BASE, [
        { id: "baseline", config: {} },
        { id: "s2", config: { model: "bad" } },
      ]);
    });

    // baseline ok, s2 fails → only 1 ok → no record.
    expect(result.current.state.results.s2).toEqual({
      ok: false,
      error: "boom",
    });
    expect(result.current.state.recordId).toBeNull();
    expect(createAbRun).not.toHaveBeenCalled();
  });

  it("does not persist when projectId is absent", async () => {
    const { result } = renderHook(() =>
      useAbComparison({ surface: "inline", dispatch: okDispatch }),
    );
    await act(async () => {
      await result.current.run(BASE, [
        { id: "baseline", config: {} },
        { id: "s2", config: { model: "b" } },
      ]);
    });
    expect(createAbRun).not.toHaveBeenCalled();
    expect(result.current.state.recordId).toBeNull();
  });

  it("adopt records the choice by slot id and returns the chosen text", async () => {
    const { result } = renderHook(() =>
      useAbComparison({
        surface: "chat",
        projectId: "p1",
        dispatch: okDispatch,
      }),
    );
    await act(async () => {
      await result.current.run(BASE, [
        { id: "baseline", config: {} },
        { id: "s2", config: { model: "b" } },
      ]);
    });

    let adopted: string | null = null;
    await act(async () => {
      adopted = await result.current.adopt("s2");
    });

    expect(adopted).toBe("out:b");
    expect(result.current.state.chosenId).toBe("s2");
    expect(setAbRunChosen).toHaveBeenCalledWith("p1", "rec-1", "s2");
  });

  it("adopt returns null for a failed slot and does not record", async () => {
    const halfFail: AbDispatcher = async (_messages, config) =>
      config.model === "bad"
        ? { ok: false, error: "boom" }
        : { ok: true, text: "ok" };
    const { result } = renderHook(() =>
      useAbComparison({ surface: "chat", projectId: "p1", dispatch: halfFail }),
    );
    await act(async () => {
      await result.current.run(BASE, [
        { id: "baseline", config: {} },
        { id: "s2", config: { model: "bad" } },
      ]);
    });

    let adopted: string | null = "x";
    await act(async () => {
      adopted = await result.current.adopt("s2");
    });
    expect(adopted).toBeNull();
    expect(setAbRunChosen).not.toHaveBeenCalled();
  });

  it("running flag flips true during the run", async () => {
    let resolveRun!: () => void;
    const gate = new Promise<void>((r) => (resolveRun = r));
    const slow: AbDispatcher = async () => {
      await gate;
      return { ok: true, text: "x" };
    };
    const { result } = renderHook(() =>
      useAbComparison({ surface: "chat", dispatch: slow }),
    );

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run(BASE, [
        { id: "baseline", config: {} },
        { id: "s2", config: { model: "b" } },
      ]);
    });
    await waitFor(() => expect(result.current.state.running).toBe(true));
    await act(async () => {
      resolveRun();
      await runPromise;
    });
    expect(result.current.state.running).toBe(false);
  });

  it("reuses unchanged ok slots and only regenerates edited ones", async () => {
    const calls: string[] = [];
    const dispatch: AbDispatcher = async (_messages, config) => {
      calls.push(config.model ?? "default");
      return { ok: true, text: `out:${config.model ?? "default"}` };
    };
    const { result } = renderHook(() =>
      useAbComparison({ surface: "chat", projectId: "p1", dispatch }),
    );

    // 1st: baseline(default) + s2(b1) both generated.
    await act(async () => {
      await result.current.run(BASE, [
        { id: "baseline", config: {} },
        { id: "s2", config: { model: "b1" } },
      ]);
    });

    // 2nd: baseline unchanged → reused; s2 edited to b2 → regenerated.
    await act(async () => {
      await result.current.run(BASE, [
        { id: "baseline", config: {} },
        { id: "s2", config: { model: "b2" } },
      ]);
    });

    expect(result.current.state.results.baseline).toEqual({
      ok: true,
      text: "out:default",
    });
    expect(result.current.state.results.s2).toEqual({
      ok: true,
      text: "out:b2",
    });

    // baseline dispatched once total = not regenerated.
    expect(calls.filter((c) => c === "default")).toHaveLength(1);
    expect(calls).toEqual(["default", "b1", "b2"]);
    expect(createAbRun).toHaveBeenCalledTimes(2);
  });

  it("invalidate drops a slot result, keeps others, and makes it unadoptable", async () => {
    const { result } = renderHook(() =>
      useAbComparison({
        surface: "chat",
        projectId: "p1",
        dispatch: okDispatch,
      }),
    );
    await act(async () => {
      await result.current.run(BASE, [
        { id: "baseline", config: {} },
        { id: "s2", config: { model: "b" } },
      ]);
    });
    expect(result.current.state.results.s2).toEqual({
      ok: true,
      text: "out:b",
    });

    act(() => result.current.invalidate("s2"));

    expect(result.current.state.results.baseline).toEqual({
      ok: true,
      text: "out:default",
    });
    expect(result.current.state.results.s2).toBeNull();

    let adoptedS2: string | null = "x";
    await act(async () => {
      adoptedS2 = await result.current.adopt("s2");
    });
    expect(adoptedS2).toBeNull();

    let adoptedBase: string | null = null;
    await act(async () => {
      adoptedBase = await result.current.adopt("baseline");
    });
    expect(adoptedBase).toBe("out:default");
    // invalidate diverged the displayed state from the persisted record →
    // recordId was cleared, so adopting now returns text but skips the DB write
    // (no chosen written against a stale/mismatched record).
    expect(setAbRunChosen).not.toHaveBeenCalled();
  });

  it("invalidate unsets chosen when the chosen slot is invalidated", async () => {
    const { result } = renderHook(() =>
      useAbComparison({
        surface: "chat",
        projectId: "p1",
        dispatch: okDispatch,
      }),
    );
    await act(async () => {
      await result.current.run(BASE, [
        { id: "baseline", config: {} },
        { id: "s2", config: { model: "b" } },
      ]);
    });
    await act(async () => {
      await result.current.adopt("s2");
    });
    expect(result.current.state.chosenId).toBe("s2");

    act(() => result.current.invalidate("s2"));
    expect(result.current.state.chosenId).toBeNull();
  });
});
