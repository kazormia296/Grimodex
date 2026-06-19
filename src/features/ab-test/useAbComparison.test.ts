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
});
