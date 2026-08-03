// @vitest-environment happy-dom
//
// useMapBoardData のプロジェクト切替まわりの回帰テスト。gate しているのは:
//   (A) resolveActiveBoardId — 保存ボードが「このプロジェクトに属する時だけ」
//       維持し、別プロジェクトのボード id なら先頭ボードへフォールバックする決定。
//   (B) フック統合 — プロジェクト切替で activeBoardId が旧プロジェクトのボードに
//       居残らず新プロジェクトのボードへ再解決され、cross-project な board id では
//       盤面データを hydrate しない (前プロジェクトのボードが残るバグ #Map 切替)。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useMapStore } from "../mapStore";
import { resolveActiveBoardId, useMapBoardData } from "./useMapBoardData";
import type { MapBoard } from "@/db/schema";

vi.mock("../mapApi", () => ({
  listBoards: vi.fn(),
  getOrCreateBoard: vi.fn(),
  getMapBoard: vi.fn(),
  listNodePositions: vi.fn(),
  listUserEdges: vi.fn(),
  listFrames: vi.fn(),
  listStickies: vi.fn(),
  listAiBranches: vi.fn(),
  // mapStore.hydrateFromBoard が import するため最小実装を提供。
  parseShowConfig: () => ({}),
  serializeShowConfig: () => "{}",
}));

vi.mock("./useMapBoardPersistence", () => ({
  markBoardHydrating: vi.fn(),
  clearBoardHydrating: vi.fn(),
  syncBoardPersistenceSnapshot: vi.fn(),
}));

import {
  listBoards,
  getOrCreateBoard,
  getMapBoard,
  listNodePositions,
  listUserEdges,
  listFrames,
  listStickies,
  listAiBranches,
} from "../mapApi";

function board(id: string, projectId: string): MapBoard {
  return {
    id,
    projectId,
    title: "Main",
    sortOrder: 0,
    mode: "free",
    viewportX: 0,
    viewportY: 0,
    viewportZoom: 1,
    showConfig: "{}",
    colorBy: "none",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  } as MapBoard;
}

const boardsByProject: Record<string, MapBoard[]> = {
  projA: [board("a1", "projA")],
  projB: [board("b1", "projB")],
};
const boardById: Record<string, MapBoard> = {
  a1: board("a1", "projA"),
  b1: board("b1", "projB"),
};
// 盤面ごとに識別できる positions。data がプロジェクトに追従するか検証する。
const positionsByBoard: Record<string, { nodeId: string }[]> = {
  a1: [{ nodeId: "node-A" }],
  b1: [{ nodeId: "node-B" }],
};

beforeEach(() => {
  vi.mocked(listBoards).mockImplementation(
    async (pid: string) => boardsByProject[pid] ?? [],
  );
  vi.mocked(getMapBoard).mockImplementation(
    async (bid: string) => boardById[bid],
  );
  vi.mocked(listNodePositions).mockImplementation(
    async (bid: string) => (positionsByBoard[bid] ?? []) as never,
  );
  vi.mocked(getOrCreateBoard).mockImplementation(async (pid: string) =>
    board(`main-${pid}`, pid),
  );
  vi.mocked(listUserEdges).mockResolvedValue([]);
  vi.mocked(listFrames).mockResolvedValue([]);
  vi.mocked(listStickies).mockResolvedValue([]);
  vi.mocked(listAiBranches).mockResolvedValue([]);
  useMapStore.setState({ activeBoardId: null });
});

describe("resolveActiveBoardId", () => {
  it("保存ボードがこのプロジェクトに属するなら維持する", () => {
    expect(resolveActiveBoardId("b1", [{ id: "b1" }, { id: "b2" }])).toBe("b1");
  });

  it("保存ボードが別プロジェクト(=このボード一覧に無い)なら先頭ボードへ", () => {
    expect(resolveActiveBoardId("a1", [{ id: "b1" }, { id: "b2" }])).toBe("b1");
  });

  it("保存ボードが null なら先頭ボード", () => {
    expect(resolveActiveBoardId(null, [{ id: "b1" }])).toBe("b1");
  });

  it("ボードが空なら null", () => {
    expect(resolveActiveBoardId("a1", [])).toBeNull();
  });
});

describe("useMapBoardData — project switch", () => {
  it("旧プロジェクトの activeBoardId が残っていても新プロジェクトのボードへ再解決する", async () => {
    // 前プロジェクト A のボードが store に残った状態で B を開く。
    useMapStore.setState({ activeBoardId: "a1" });

    const { result } = renderHook(() => useMapBoardData("projB"));

    await waitFor(() =>
      expect(useMapStore.getState().activeBoardId).toBe("b1"),
    );
    expect(useMapStore.getState().activeBoardId).not.toBe("a1");
    // 盤面データも B のものになる (cross-project な a1 は hydrate されない)。
    await waitFor(() =>
      expect(result.current.positions).toEqual([{ nodeId: "node-B" }]),
    );
  });

  it("projectId 変化でボード選択とデータが新プロジェクトへ追従する", async () => {
    useMapStore.setState({ activeBoardId: "a1" });

    const { result, rerender } = renderHook(
      ({ p }: { p: string }) => useMapBoardData(p),
      { initialProps: { p: "projA" } },
    );

    await waitFor(() =>
      expect(useMapStore.getState().activeBoardId).toBe("a1"),
    );
    await waitFor(() =>
      expect(result.current.positions).toEqual([{ nodeId: "node-A" }]),
    );

    rerender({ p: "projB" });

    await waitFor(() =>
      expect(useMapStore.getState().activeBoardId).toBe("b1"),
    );
    await waitFor(() =>
      expect(result.current.positions).toEqual([{ nodeId: "node-B" }]),
    );
  });

  it("座標だけの更新は structure/layout revision を進めず、構造変更は進める", async () => {
    useMapStore.setState({ activeBoardId: "a1" });
    const { result } = renderHook(() => useMapBoardData("projA"));
    await waitFor(() =>
      expect(result.current.positions).toEqual([{ nodeId: "node-A" }]),
    );
    const structureRevision = result.current.positionsStructureRevision;
    const layoutRevision = result.current.positionsLayoutRevision;

    act(() => {
      result.current.setPositionCoordinates((previous) =>
        previous.map((position) => ({
          ...position,
          x: 123,
          y: 456,
        })),
      );
    });
    expect(result.current.positions).toEqual([
      { nodeId: "node-A", x: 123, y: 456 },
    ]);
    expect(result.current.positionsStructureRevision).toBe(structureRevision);
    expect(result.current.positionsLayoutRevision).toBe(layoutRevision);

    act(() => {
      result.current.setPositions((previous) => [
        ...previous,
        { nodeId: "node-B" } as never,
      ]);
    });
    expect(result.current.positionsStructureRevision).toBe(
      structureRevision + 1,
    );
    expect(result.current.positionsLayoutRevision).toBe(layoutRevision + 1);

    act(() => {
      result.current.setPositions((previous) => previous.slice(0, -1));
    });
    expect(result.current.positionsStructureRevision).toBe(
      structureRevision + 2,
    );
    expect(result.current.positionsLayoutRevision).toBe(layoutRevision + 2);
  });
});
