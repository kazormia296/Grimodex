// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// api をモックして DB I/O を切り離す。
const createAbComparison = vi.fn();
const setAbChosen = vi.fn();
vi.mock("./api", () => ({
  createAbComparison: (...args: unknown[]) => createAbComparison(...args),
  setAbChosen: (...args: unknown[]) => setAbChosen(...args),
}));

import { useAbComparison } from "./useAbComparison";
import type { AbDispatcher } from "./abHarness";

const okDispatch: AbDispatcher = async (_messages, config) => ({
  ok: true,
  text: `out:${config.model ?? "default"}`,
});

describe("useAbComparison", () => {
  beforeEach(() => {
    createAbComparison.mockReset();
    setAbChosen.mockReset();
    createAbComparison.mockResolvedValue({ id: "rec-1" });
    setAbChosen.mockResolvedValue(undefined);
  });

  it("runs both sides and stores results + record id", async () => {
    const { result } = renderHook(() =>
      useAbComparison({
        surface: "chat",
        projectId: "p1",
        dispatch: okDispatch,
      }),
    );

    await act(async () => {
      await result.current.run(
        { messages: [{ role: "user", content: "hi" }] },
        { model: "a" },
        { model: "b" },
      );
    });

    expect(result.current.state.resultA).toEqual({ ok: true, text: "out:a" });
    expect(result.current.state.resultB).toEqual({ ok: true, text: "out:b" });
    expect(result.current.state.recordId).toBe("rec-1");
    expect(createAbComparison).toHaveBeenCalledTimes(1);
    const arg = createAbComparison.mock.calls[0][0];
    expect(arg).toMatchObject({
      projectId: "p1",
      surface: "chat",
      modelA: "a",
      modelB: "b",
      responseA: "out:a",
      responseB: "out:b",
    });
  });

  it("does not persist when one side fails", async () => {
    const halfFail: AbDispatcher = async (_messages, config) =>
      config.model === "bad"
        ? { ok: false, error: "boom" }
        : { ok: true, text: "ok" };

    const { result } = renderHook(() =>
      useAbComparison({ surface: "chat", projectId: "p1", dispatch: halfFail }),
    );

    await act(async () => {
      await result.current.run(
        { messages: [{ role: "user", content: "hi" }] },
        { model: "bad" },
        { model: "good" },
      );
    });

    expect(result.current.state.resultA).toEqual({ ok: false, error: "boom" });
    expect(result.current.state.recordId).toBeNull();
    expect(createAbComparison).not.toHaveBeenCalled();
  });

  it("does not persist when projectId is absent", async () => {
    const { result } = renderHook(() =>
      useAbComparison({ surface: "inline", dispatch: okDispatch }),
    );
    await act(async () => {
      await result.current.run(
        { messages: [{ role: "user", content: "hi" }] },
        {},
        { model: "b" },
      );
    });
    expect(createAbComparison).not.toHaveBeenCalled();
    expect(result.current.state.recordId).toBeNull();
  });

  it("adopt records the choice and returns the chosen text", async () => {
    const { result } = renderHook(() =>
      useAbComparison({
        surface: "chat",
        projectId: "p1",
        dispatch: okDispatch,
      }),
    );
    await act(async () => {
      await result.current.run(
        { messages: [{ role: "user", content: "hi" }] },
        { model: "a" },
        { model: "b" },
      );
    });

    let adopted: string | null = null;
    await act(async () => {
      adopted = await result.current.adopt("b");
    });

    expect(adopted).toBe("out:b");
    expect(result.current.state.chosen).toBe("b");
    expect(setAbChosen).toHaveBeenCalledWith("p1", "rec-1", "b");
  });

  it("adopt returns null for a failed side and does not record", async () => {
    const halfFail: AbDispatcher = async (_messages, config) =>
      config.model === "bad"
        ? { ok: false, error: "boom" }
        : { ok: true, text: "ok" };
    const { result } = renderHook(() =>
      useAbComparison({ surface: "chat", projectId: "p1", dispatch: halfFail }),
    );
    await act(async () => {
      await result.current.run(
        { messages: [{ role: "user", content: "hi" }] },
        { model: "bad" },
        { model: "good" },
      );
    });

    let adopted: string | null = "x";
    await act(async () => {
      adopted = await result.current.adopt("a");
    });
    expect(adopted).toBeNull();
    expect(setAbChosen).not.toHaveBeenCalled();
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
      runPromise = result.current.run(
        { messages: [{ role: "user", content: "hi" }] },
        {},
        {},
      );
    });
    await waitFor(() => expect(result.current.state.running).toBe(true));
    await act(async () => {
      resolveRun();
      await runPromise;
    });
    expect(result.current.state.running).toBe(false);
  });

  it("reuses the A result on a later run and only regenerates B", async () => {
    const calls: string[] = [];
    const dispatch: AbDispatcher = async (_messages, config) => {
      calls.push(config.model ?? "default");
      return { ok: true, text: `out:${config.model ?? "default"}` };
    };
    const { result } = renderHook(() =>
      useAbComparison({ surface: "chat", projectId: "p1", dispatch }),
    );

    // 1 回目: A(既定) + B(b1) を両方生成。
    await act(async () => {
      await result.current.run(
        { messages: [{ role: "user", content: "hi" }] },
        {},
        { model: "b1" },
      );
    });
    expect(result.current.state.resultA).toEqual({
      ok: true,
      text: "out:default",
    });

    // 2 回目: A は流用し B(b2) のみ生成。
    await act(async () => {
      await result.current.run(
        { messages: [{ role: "user", content: "hi" }] },
        {},
        { model: "b2" },
      );
    });
    expect(result.current.state.resultA).toEqual({
      ok: true,
      text: "out:default",
    });
    expect(result.current.state.resultB).toEqual({ ok: true, text: "out:b2" });

    // A(既定) の dispatch は通算 1 回だけ = 再生成されていない。
    expect(calls.filter((c) => c === "default")).toHaveLength(1);
    expect(calls).toContain("b1");
    expect(calls).toContain("b2");
    expect(calls).toHaveLength(3);

    // 履歴は run ごとに記録される。A 流用時も configA は常に既定 ({}) なので
    // 2 回目の record は「modelA=null の既定 A」と「新しい B(b2)」を正しく対にする
    // (流用しても A メタデータが mode で汚染されない契約の固定)。
    expect(createAbComparison).toHaveBeenCalledTimes(2);
    expect(createAbComparison.mock.calls[1][0]).toMatchObject({
      modelA: null,
      promptVariantA: null,
      responseA: "out:default",
      modelB: "b2",
      responseB: "out:b2",
    });
  });

  it("clearSideB drops B, keeps A, and makes B unadoptable", async () => {
    const { result } = renderHook(() =>
      useAbComparison({
        surface: "chat",
        projectId: "p1",
        dispatch: okDispatch,
      }),
    );
    await act(async () => {
      await result.current.run(
        { messages: [{ role: "user", content: "hi" }] },
        { model: "a" },
        { model: "b" },
      );
    });
    expect(result.current.state.resultB).toEqual({ ok: true, text: "out:b" });

    act(() => result.current.clearSideB());

    // A は残り B は消える。
    expect(result.current.state.resultA).toEqual({ ok: true, text: "out:a" });
    expect(result.current.state.resultB).toBeNull();

    // B は採用不可 (null) だが A は依然採用できる。
    let adoptedB: string | null = "x";
    await act(async () => {
      adoptedB = await result.current.adopt("b");
    });
    expect(adoptedB).toBeNull();

    let adoptedA: string | null = null;
    await act(async () => {
      adoptedA = await result.current.adopt("a");
    });
    expect(adoptedA).toBe("out:a");
  });

  it("clearSideB unsets the chosen flag when B was the chosen side", async () => {
    const { result } = renderHook(() =>
      useAbComparison({
        surface: "chat",
        projectId: "p1",
        dispatch: okDispatch,
      }),
    );
    await act(async () => {
      await result.current.run(
        { messages: [{ role: "user", content: "hi" }] },
        { model: "a" },
        { model: "b" },
      );
    });
    await act(async () => {
      await result.current.adopt("b");
    });
    expect(result.current.state.chosen).toBe("b");

    act(() => result.current.clearSideB());
    expect(result.current.state.chosen).toBeNull();
  });
});
