// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import type { PostEffectRun } from "@/features/post-effect/types";

// api をモックして IPC を切り離す。
const listPostEffectRuns = vi.fn();
vi.mock("@/features/post-effect/api", () => ({
  listPostEffectRuns: (...args: unknown[]) => listPostEffectRuns(...args),
}));

import { useTreeStore } from "@/features/tree/treeStore";
import {
  useEffectLastRuns,
  EFFECT_LAST_RUN_TARGETS,
} from "./useEffectLastRuns";

function makeRun(over: Partial<PostEffectRun>): PostEffectRun {
  return {
    id: "run-1",
    projectId: "p1",
    effectType: "review",
    scopeType: "project",
    scopeTargetId: null,
    model: "test-model",
    promptVersion: "v1",
    inputHash: null,
    status: "completed",
    summary: null,
    errorMessage: null,
    startedAt: "2026-07-06T00:00:00.000Z",
    completedAt: "2026-07-06T00:01:00.000Z",
    ...over,
  };
}

/** effectType ごとに completedAt を変えた completed run を 1 件返すモック。 */
function mockOneCompletedPerEffect(): void {
  listPostEffectRuns.mockImplementation(
    async (params: { effectType: string }) => [
      makeRun({
        effectType: params.effectType as PostEffectRun["effectType"],
        completedAt: `2026-07-06T01:00:00.000Z#${params.effectType}`,
      }),
    ],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useTreeStore.setState({ projectId: "p1" });
});

afterEach(() => cleanup());

describe("useEffectLastRuns", () => {
  it("8 観点それぞれに listPostEffectRuns を projectId + effectType + limit で呼ぶ", async () => {
    mockOneCompletedPerEffect();
    const { result } = renderHook(() => useEffectLastRuns());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(listPostEffectRuns).toHaveBeenCalledTimes(8);
    for (const effect of EFFECT_LAST_RUN_TARGETS) {
      expect(listPostEffectRuns).toHaveBeenCalledWith({
        projectId: "p1",
        effectType: effect,
        limit: 10,
      });
      expect(result.current.lastRuns[effect]).toBe(
        `2026-07-06T01:00:00.000Z#${effect}`,
      );
    }
    // 生のまま 8 キー（consistency 系を畳まない）
    expect(Object.keys(result.current.lastRuns)).toHaveLength(8);
  });

  it("completed 以外が混ざる配列では最初の completed の completedAt を選ぶ", async () => {
    listPostEffectRuns.mockImplementation(
      async (params: { effectType: string }) => {
        if (params.effectType !== "typo_detection") return [];
        // started_at 降順（実 API と同じ）: running → failed → completed(新) → completed(旧)
        return [
          makeRun({ id: "r4", status: "running", completedAt: null }),
          makeRun({ id: "r3", status: "failed", completedAt: null }),
          makeRun({
            id: "r2",
            status: "completed",
            completedAt: "2026-07-06T09:00:00.000Z",
          }),
          makeRun({
            id: "r1",
            status: "completed",
            completedAt: "2026-07-05T09:00:00.000Z",
          }),
        ];
      },
    );
    const { result } = renderHook(() => useEffectLastRuns());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.lastRuns.typo_detection).toBe(
      "2026-07-06T09:00:00.000Z",
    );
    // completed の無い観点はキーごと入らない
    expect(result.current.lastRuns.review).toBeUndefined();
  });

  it("失敗した effect は undefined のまま、他の結果は活きる（throw しない）", async () => {
    listPostEffectRuns.mockImplementation(
      async (params: { effectType: string }) => {
        if (params.effectType === "review") throw new Error("ipc failed");
        return [
          makeRun({
            effectType: params.effectType as PostEffectRun["effectType"],
          }),
        ];
      },
    );
    const { result } = renderHook(() => useEffectLastRuns());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.lastRuns.review).toBeUndefined();
    expect(result.current.lastRuns.typo_detection).toBe(
      "2026-07-06T00:01:00.000Z",
    );
    expect(Object.keys(result.current.lastRuns)).toHaveLength(7);
  });

  it("refresh() で再取得し、更新後の値が反映される", async () => {
    mockOneCompletedPerEffect();
    const { result } = renderHook(() => useEffectLastRuns());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(listPostEffectRuns).toHaveBeenCalledTimes(8);

    listPostEffectRuns.mockImplementation(async () => [
      makeRun({ completedAt: "2026-07-06T12:00:00.000Z" }),
    ]);
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(listPostEffectRuns).toHaveBeenCalledTimes(16);
    expect(result.current.lastRuns.review).toBe("2026-07-06T12:00:00.000Z");
  });

  it("projectId が空なら何もしない", async () => {
    useTreeStore.setState({ projectId: "" });
    const { result } = renderHook(() => useEffectLastRuns());

    // フェッチが走らないので loading は false のまま
    expect(result.current.loading).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(listPostEffectRuns).not.toHaveBeenCalled();
    expect(result.current.lastRuns).toEqual({});
  });

  it("アンマウント後に解決しても setState しない（エラーを出さない）", async () => {
    let resolve!: (runs: PostEffectRun[]) => void;
    listPostEffectRuns.mockImplementation(
      () =>
        new Promise<PostEffectRun[]>((r) => {
          resolve = r;
        }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { unmount } = renderHook(() => useEffectLastRuns());
      unmount();
      await act(async () => {
        resolve([makeRun({})]);
        await Promise.resolve();
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
