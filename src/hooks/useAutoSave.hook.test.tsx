// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAutoSave,
  discardAutoSavesForDocument,
  flushAllAutoSaves,
  flushAutoSavesForKind,
  hasPendingOrFailedAutoSaveForDocument,
  registerAutoSaveForQuiesce,
  useAutoSave,
} from "./useAutoSave";
import { _resetEditorAnalysisSchedulerForTests } from "@/lib/editorAnalysisScheduler";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

vi.mock("@/lib/a11y/announcer", () => ({
  announce: vi.fn(),
}));

describe("useAutoSave callback freshness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetEditorAnalysisSchedulerForTests();
  });

  afterEach(() => {
    _resetEditorAnalysisSchedulerForTests();
    vi.useRealTimers();
  });

  it("executes the latest save callback after a rerender", async () => {
    const firstSave = vi.fn().mockResolvedValue(undefined);
    const latestSave = vi.fn().mockResolvedValue(undefined);
    const { result, rerender, unmount } = renderHook(
      ({ save }) => useAutoSave(save, 100),
      { initialProps: { save: firstSave } },
    );

    act(() => result.current.schedule());
    rerender({ save: latestSave });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(firstSave).not.toHaveBeenCalled();
    expect(latestSave).toHaveBeenCalledOnce();
    unmount();
  });

  it("keeps an unmounted pending save registered until it settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = vi.fn(() => gate);
    const { result, unmount } = renderHook(() => useAutoSave(save, 100));

    act(() => result.current.schedule());
    unmount();

    let quiesced = false;
    const quiescing = flushAllAutoSaves().then(() => {
      quiesced = true;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(save).toHaveBeenCalledOnce();
    expect(quiesced).toBe(false);

    release();
    await quiescing;
    expect(quiesced).toBe(true);
  });

  it("retains a failed unmount flush for the next global quiesce retry", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useAutoSave(save, 100));

    act(() => result.current.schedule());
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(save).toHaveBeenCalledOnce();

    await flushAllAutoSaves();
    expect(save).toHaveBeenCalledTimes(2);

    await flushAllAutoSaves();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("reports pending and failed work for the exact document without blocking on a clean mount", async () => {
    const key = {
      kind: "tree",
      id: "scene-probe",
      storage: "file",
    } as const;
    const otherKey = {
      kind: "tree",
      id: "scene-other",
      storage: "file",
    } as const;
    const save = vi.fn().mockRejectedValue(new Error("disk full"));
    const { result, unmount } = renderHook(() =>
      useAutoSave(save, 100, { documentKey: () => key }),
    );

    expect(hasPendingOrFailedAutoSaveForDocument(key)).toBe(false);
    act(() => result.current.schedule());
    expect(hasPendingOrFailedAutoSaveForDocument(key)).toBe(true);
    expect(hasPendingOrFailedAutoSaveForDocument(otherKey)).toBe(false);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hasPendingOrFailedAutoSaveForDocument(key)).toBe(true);

    act(() => discardAutoSavesForDocument(key));
    expect(hasPendingOrFailedAutoSaveForDocument(key)).toBe(false);
  });

  it("scoped flush retries a retired editor without draining another kind", async () => {
    const treeKey = {
      kind: "tree",
      id: "scene-retired",
      storage: "database",
    } as const;
    const codexKey = {
      kind: "codex",
      id: "codex-live",
      phaseId: null,
    } as const;
    const treeSave = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue(undefined);
    const codexSave = vi.fn().mockResolvedValue(undefined);
    const tree = renderHook(() =>
      useAutoSave(treeSave, 100, { documentKey: () => treeKey }),
    );
    const codex = renderHook(() =>
      useAutoSave(codexSave, 100, { documentKey: () => codexKey }),
    );

    act(() => {
      tree.result.current.schedule();
      codex.result.current.schedule();
    });
    tree.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(treeSave).toHaveBeenCalledOnce();

    await flushAutoSavesForKind("tree");
    expect(treeSave).toHaveBeenCalledTimes(2);
    expect(codexSave).not.toHaveBeenCalled();

    codex.unmount();
  });

  it("explicit document reload discards a failed unmounted AutoSave before global retry", async () => {
    const key = {
      kind: "tree",
      id: "scene-reload",
      storage: "file",
    } as const;
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("mount unavailable"))
      .mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() =>
      useAutoSave(save, 100, { documentKey: () => key }),
    );

    act(() => result.current.schedule());
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(save).toHaveBeenCalledOnce();

    act(() => discardAutoSavesForDocument(key));
    await expect(flushAllAutoSaves()).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledOnce();
  });

  it("explicit discard cancels a paused edit before unmount retirement", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useAutoSave(save, 100));

    act(() => {
      result.current.schedule();
      result.current.pause();
      // Mirrors the tab's explicit "Close without saving" handler.
      result.current.cancel();
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await expect(flushAllAutoSaves()).resolves.toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it("retires the save identity before starting the detached flush", async () => {
    const order: string[] = [];
    const save = vi.fn(async () => {
      order.push("save");
    });
    const onActivate = vi.fn(() => order.push("activate"));
    const onRetire = vi.fn(() => order.push("retire"));
    const { result, unmount } = renderHook(() =>
      useAutoSave(save, 100, { onActivate, onRetire }),
    );

    act(() => result.current.schedule());
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onActivate).toHaveBeenCalledOnce();
    expect(onRetire).toHaveBeenCalledOnce();
    expect(order).toEqual(["activate", "retire", "save"]);
  });

  it("re-snapshots when virtualization retires an AutoSave during strict flush", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = createAutoSave(
      vi.fn(() => firstGate),
      100,
    );
    const unregisterFirst = registerAutoSaveForQuiesce(first);
    first.schedule();

    let strictSettled = false;
    const strictFlush = flushAllAutoSaves().then(() => {
      strictSettled = true;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    let releaseRetiring!: () => void;
    const retiringGate = new Promise<void>((resolve) => {
      releaseRetiring = resolve;
    });
    const retiringSave = vi.fn(() => retiringGate);
    const retiringHook = renderHook(() => useAutoSave(retiringSave, 100));
    act(() => retiringHook.result.current.schedule());
    retiringHook.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(retiringSave).toHaveBeenCalledOnce();

    releaseFirst();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(strictSettled).toBe(false);

    releaseRetiring();
    await strictFlush;
    expect(strictSettled).toBe(true);
    unregisterFirst();
  });
});
