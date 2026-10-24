// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Node, NodeChange } from "@xyflow/react";
import type { MapNodePositionRecord } from "../types";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { toast } from "sonner";
import { rootCause } from "@/lib/debugLog";
import { useMapPositionPersistence } from "./useMapPositionPersistence";
import { setNodePinned, updateFrame, upsertNodePosition } from "../mapApi";
import {
  _resetMapPersistenceWritesForTests,
  flushMapPersistenceWritesStrict,
} from "./mapPersistenceWriteQueue";

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "project-1",
  useCurrentProjectId: () => "project-1",
}));

vi.mock("../mapApi", () => ({
  upsertNodePosition: vi.fn(),
  setNodePinned: vi.fn(),
  updateFrame: vi.fn(),
  deleteUserEdge: vi.fn(),
  createUserEdge: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

function position(overrides: Partial<MapNodePositionRecord> = {}) {
  return {
    id: "pos-s1",
    boardId: "board-1",
    nodeRefType: "scene",
    treeNodeId: "s1",
    codexEntryId: null,
    snippetId: null,
    stickyId: null,
    aiBranchId: null,
    x: 10,
    y: 20,
    pinned: 0,
    zIndex: 0,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  } satisfies MapNodePositionRecord;
}

function makeInput(
  overrides: Partial<Parameters<typeof useMapPositionPersistence>[0]> = {},
): Parameters<typeof useMapPositionPersistence>[0] {
  return {
    boardId: "board-1",
    mode: "free",
    getNodes: () => [],
    setPositions: vi.fn(),
    setPositionCoordinates: vi.fn(),
    setFrames: vi.fn(),
    setNodes: vi.fn(),
    setUserEdges: vi.fn(),
    userEdgesRef: { current: [] },
    persistingRef: { current: new Set() },
    ...overrides,
  };
}

describe("useMapPositionPersistence — position revision routing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetMapPersistenceWritesForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("free-mode drag は coordinate-only publisher を使う", async () => {
    vi.mocked(upsertNodePosition).mockResolvedValue(position({ x: 30, y: 40 }));
    const input = makeInput();
    const { result } = renderHook(() => useMapPositionPersistence(input));

    await act(async () => {
      await result.current.persistPosition("scene:s1", 30, 40);
    });

    expect(input.setPositionCoordinates).toHaveBeenCalledOnce();
    expect(input.setPositions).not.toHaveBeenCalled();
    expect(setNodePinned).not.toHaveBeenCalled();
  });

  // DA-2b W-1 (Negative (11); DR-DA2B-R5, R8): activation stages 4-7 refuse
  // the generic Map write; Drizzle wraps the refusal with the statement and
  // its params. The failure toast shows the generic text instead.
  it("D2a に拒否された位置の保存は SQL と marker を出さず一般の文で知らせる", async () => {
    const refusal = new DrizzleQueryError(
      'update "map_node_positions" set "x" = ?, "y" = ? where "map_node_positions"."id" = ?',
      [30, 40, "pos-secret"],
      new Error(
        "db_execute rejected: D2A_EGRESS_DENIED: plaintext-publication: publication is closed during startup quiescence",
      ),
    );
    vi.mocked(upsertNodePosition).mockRejectedValue(refusal);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { result } = renderHook(() => useMapPositionPersistence(makeInput()));

    await act(async () => {
      await result.current.persistPosition("scene:s1", 30, 40);
    });

    expect(toast.error).toHaveBeenCalledTimes(1);
    const description = String(
      (vi.mocked(toast.error).mock.calls[0]?.[1] as { description?: unknown })
        ?.description,
    );
    expect(description).toBe(rootCause(refusal));
    for (const leaked of [
      "Failed query",
      "map_node_positions",
      "pos-secret",
      "D2A_EGRESS_DENIED",
    ]) {
      expect(description).not.toContain(leaked);
    }
    consoleError.mockRestore();
  });

  it("theme-mode drag は auto-pin を含む invalidating publisher を使う", async () => {
    const unpinned = position({ x: 30, y: 40 });
    const pinned = position({ x: 30, y: 40, pinned: 1 });
    vi.mocked(upsertNodePosition).mockResolvedValue(unpinned);
    vi.mocked(setNodePinned).mockResolvedValue(pinned);
    const input = makeInput({ mode: "theme" });
    const { result } = renderHook(() => useMapPositionPersistence(input));

    await act(async () => {
      await result.current.persistPosition("scene:s1", 30, 40);
    });

    expect(setNodePinned).toHaveBeenCalledWith("pos-s1", true);
    expect(input.setPositions).toHaveBeenCalledOnce();
    expect(input.setPositionCoordinates).not.toHaveBeenCalled();
  });

  it("既に pinned の theme-mode drag は coordinate-only publisher を使う", async () => {
    vi.mocked(upsertNodePosition).mockResolvedValue(
      position({ x: 30, y: 40, pinned: 1 }),
    );
    const input = makeInput({ mode: "theme" });
    const { result } = renderHook(() => useMapPositionPersistence(input));

    await act(async () => {
      await result.current.persistPosition("scene:s1", 30, 40);
    });

    expect(setNodePinned).not.toHaveBeenCalled();
    expect(input.setPositionCoordinates).toHaveBeenCalledOnce();
    expect(input.setPositions).not.toHaveBeenCalled();
  });

  it("unmount cleanup flushes the latest pending frame resize", async () => {
    vi.mocked(setNodePinned).mockResolvedValue(undefined);
    const frameNode = {
      id: "frame:frame-1",
      position: { x: 0, y: 0 },
      data: {},
      style: { width: 400, height: 300 },
    } as Node;
    const input = makeInput({ getNodes: () => [frameNode] });
    const { result, unmount } = renderHook(() =>
      useMapPositionPersistence(input),
    );

    act(() => {
      result.current.onNodesChange([
        {
          id: "frame:frame-1",
          type: "dimensions",
          dimensions: { width: 640, height: 480 },
          setAttributes: true,
        } as NodeChange,
      ]);
    });
    unmount();
    await flushMapPersistenceWritesStrict();

    expect(updateFrame).toHaveBeenCalledOnce();
    expect(updateFrame).toHaveBeenCalledWith("frame-1", {
      width: 640,
      height: 480,
    });
    expect(input.setFrames).toHaveBeenCalledOnce();
  });
});
