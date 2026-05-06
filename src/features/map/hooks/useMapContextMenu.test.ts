// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMapContextMenu } from "./useMapContextMenu";
import type { MapNodePositionRecord } from "../types";

vi.mock("../mapApi", () => ({
  setNodePinned: vi.fn().mockResolvedValue(null),
  updateNodePosition: vi.fn().mockResolvedValue(null),
  upsertNodePosition: vi.fn().mockResolvedValue({ id: "pos-1" }),
  deleteNodePosition: vi.fn().mockResolvedValue(undefined),
  promoteSticky: vi.fn().mockResolvedValue({
    updatedPosition: { id: "pos-1" },
  }),
}));

vi.mock("../utils/nodeIdCodec", () => ({
  findPosByNodeId: vi.fn(),
  buildUpsertArgs: vi.fn().mockReturnValue(null),
}));

import { findPosByNodeId } from "../utils/nodeIdCodec";
import { deleteNodePosition } from "../mapApi";

const mockFindPosByNodeId = vi.mocked(findPosByNodeId);

function makeDefaultInput(overrides = {}) {
  return {
    boardId: "board-1",
    projectId: "proj-1",
    positions: [] as MapNodePositionRecord[],
    nodes: [],
    setPositions: vi.fn(),
    setStickies: vi.fn(),
    setDeletingStickyIds: vi.fn(),
    setActiveScene: vi.fn(),
    ...overrides,
  };
}

describe("useMapContextMenu — sticky 削除 (2-phase delete)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sticky ノードの handleRemoveFromBoard は setDeletingStickyIds を呼び deleteNodePosition を呼ばない", async () => {
    const stickyPos = {
      id: "pos-sticky-1",
      stickyId: "sticky-abc",
    } as MapNodePositionRecord;
    mockFindPosByNodeId.mockReturnValue(stickyPos);

    const input = makeDefaultInput();
    const { result } = renderHook(() => useMapContextMenu(input));

    // コンテキストメニューを開く
    act(() => {
      result.current.setContextMenu({
        nodeId: "sticky:sticky-abc",
        screenPosition: { x: 100, y: 100 },
        isPinned: false,
        isScene: false,
      });
    });

    await act(async () => {
      await result.current.handleRemoveFromBoard();
    });

    expect(input.setDeletingStickyIds).toHaveBeenCalledOnce();
    expect(deleteNodePosition).not.toHaveBeenCalled();
    // コンテキストメニューが閉じている
    expect(result.current.contextMenu).toBeNull();
  });

  it("non-sticky ノードの handleRemoveFromBoard は deleteNodePosition を呼ぶ", async () => {
    const scenePos = {
      id: "pos-scene-1",
      stickyId: null,
      treeNodeId: "scene-abc",
    } as unknown as MapNodePositionRecord;
    mockFindPosByNodeId.mockReturnValue(scenePos);

    const input = makeDefaultInput();
    const { result } = renderHook(() => useMapContextMenu(input));

    act(() => {
      result.current.setContextMenu({
        nodeId: "scene:scene-abc",
        screenPosition: { x: 100, y: 100 },
        isPinned: false,
        isScene: true,
      });
    });

    await act(async () => {
      await result.current.handleRemoveFromBoard();
    });

    expect(deleteNodePosition).toHaveBeenCalledWith("pos-scene-1");
    expect(input.setDeletingStickyIds).not.toHaveBeenCalled();
  });

  it("setDeletingStickyIds に stickyId が追加される", async () => {
    const stickyPos = {
      id: "pos-sticky-2",
      stickyId: "sticky-xyz",
    } as MapNodePositionRecord;
    mockFindPosByNodeId.mockReturnValue(stickyPos);

    let capturedUpdater: ((prev: Set<string>) => Set<string>) | null = null;
    const setDeletingStickyIds = vi.fn().mockImplementation((fn) => {
      capturedUpdater = fn;
    });

    const input = makeDefaultInput({ setDeletingStickyIds });
    const { result } = renderHook(() => useMapContextMenu(input));

    act(() => {
      result.current.setContextMenu({
        nodeId: "sticky:sticky-xyz",
        screenPosition: { x: 0, y: 0 },
        isPinned: false,
        isScene: false,
      });
    });

    await act(async () => {
      await result.current.handleRemoveFromBoard();
    });

    expect(capturedUpdater).not.toBeNull();
    const next = capturedUpdater!(new Set<string>());
    expect(next.has("sticky-xyz")).toBe(true);
  });
});
