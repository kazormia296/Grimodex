// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Node } from "@xyflow/react";

import { corkRotation, useMapNodes } from "./useMapNodes";
import { layoutForAsync } from "../layouts";
import type { MapNodePositionRecord } from "../types";

// ── Pure exports ────────────────────────────────────────────────────────────

describe("corkRotation", () => {
  it("同じ id は常に同じ回転値を返す（決定論的）", () => {
    expect(corkRotation("abc")).toBe(corkRotation("abc"));
  });

  it("返り値は数値である", () => {
    for (const id of ["node1", "scene:abc", "codex:xyz", ""]) {
      expect(typeof corkRotation(id)).toBe("number");
    }
  });

  it("異なる id は（通常）異なる値を返す", () => {
    const r1 = corkRotation("id-alpha");
    const r2 = corkRotation("id-beta");
    expect(r1).not.toBe(r2);
  });
});

// ── Manual curation filter (hook レベル) ───────────────────────────────────

vi.mock("../layouts", () => ({
  layoutFor: vi.fn(
    (
      _mode: string,
      {
        positions,
      }: { positions: { x: number; y: number; treeNodeId?: string | null }[] },
    ) => {
      const map = new Map<string, { x: number; y: number }>();
      for (const p of positions) {
        if (p.treeNodeId) map.set(`scene:${p.treeNodeId}`, { x: p.x, y: p.y });
      }
      return map;
    },
  ),
  layoutForAsync: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../layouts/forceEngine", () => ({
  WorkerForceLayoutEngine: class {},
}));

vi.mock("../mapApi", () => ({
  updateFrame: vi.fn(),
  deleteFrame: vi.fn(),
  updateSticky: vi.fn(),
  extractPreviewText: vi.fn().mockReturnValue(""),
}));

vi.mock("@/features/chat/chatStore", () => ({
  useChatStore: {
    getState: vi.fn().mockReturnValue({ selectSession: vi.fn() }),
  },
}));

function makePosition(id: string, treeNodeId: string): MapNodePositionRecord {
  return {
    id,
    boardId: "b1",
    nodeRefType: "scene",
    treeNodeId,
    codexEntryId: null,
    snippetId: null,
    stickyId: null,
    aiBranchId: null,
    x: 100,
    y: 100,
    pinned: 0,
    zIndex: 0,
    createdAt: "",
    updatedAt: "",
  };
}

const NOOP_REF = { current: new Set<string>() };

describe("useMapNodes — 手動キュレーション表示判定", () => {
  beforeEach(() => vi.clearAllMocks());

  it("positions にない Scene は nodes に含まれない", async () => {
    const setNodes = vi.fn();

    const treeNodes = [
      {
        id: "s1",
        nodeType: "scene",
        title: "シーン1",
        synopsis: null,
        status: "outline",
        sortOrder: "a0",
      },
      {
        id: "s2",
        nodeType: "scene",
        title: "シーン2",
        synopsis: null,
        status: "outline",
        sortOrder: "a1",
      },
    ] as Parameters<typeof useMapNodes>[0]["treeNodes"];

    // Only s1 has a position row; s2 does not
    const positions = [makePosition("pos1", "s1")];

    renderHook(() =>
      useMapNodes({
        boardId: "b1",
        positions,
        treeNodes,
        codexEntries: [],
        snippets: [],
        stickies: [],
        aiBranches: [],
        frames: [],
        show: {
          scenes: true,
          codex: false,
          notes: false,
          userEdges: true,
          derivedEdges: false,
          stickies: false,
          aiBranch: false,
          frames: false,
          snippets: false,
        },
        mode: "free",
        colorBy: "none",
        visualTheme: "default",
        modeTransitionActive: false,
        setFrames: vi.fn(),
        setStickies: vi.fn(),
        setAiBranches: vi.fn(),
        setPositions: vi.fn(),
        setNodes,
        setForceLayoutRunning: vi.fn(),
        setForceAlpha: vi.fn(),
        updateNodeTitle: vi.fn(),
        updateSynopsis: vi.fn(),
        setActiveScene: vi.fn(),
        groupDraggingRef: NOOP_REF,
        persistingRef: NOOP_REF,
      }),
    );

    // Wait for the async buildNodes effect to settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(setNodes).toHaveBeenCalled();
    const lastCall = setNodes.mock.calls.at(-1)?.[0];
    const nodes: Node[] =
      typeof lastCall === "function" ? lastCall([]) : lastCall;

    const ids = nodes.map((n: Node) => n.id);
    expect(ids).toContain("scene:s1");
    expect(ids).not.toContain("scene:s2");
  });
});

// ── theme モード: 再配置無限ループの回帰防止 ───────────────────────────────

describe("useMapNodes — theme モード再配置ループ防止", () => {
  beforeEach(() => vi.clearAllMocks());

  it("modeTransitionActive のトグルだけでは force layout を再実行しない", async () => {
    const baseProps: Parameters<typeof useMapNodes>[0] = {
      boardId: "b1",
      positions: [],
      treeNodes: [],
      codexEntries: [],
      snippets: [],
      stickies: [],
      aiBranches: [],
      frames: [],
      show: {
        scenes: true,
        codex: true,
        notes: false,
        userEdges: true,
        derivedEdges: false,
        stickies: false,
        aiBranch: false,
        frames: false,
        snippets: false,
      },
      mode: "theme",
      colorBy: "none" as const,
      visualTheme: "default",
      modeTransitionActive: false,
      setFrames: vi.fn(),
      setStickies: vi.fn(),
      setAiBranches: vi.fn(),
      setPositions: vi.fn(),
      setNodes: vi.fn(),
      setForceLayoutRunning: vi.fn(),
      setForceAlpha: vi.fn(),
      updateNodeTitle: vi.fn(),
      updateSynopsis: vi.fn(),
      setActiveScene: vi.fn(),
      groupDraggingRef: NOOP_REF,
      persistingRef: NOOP_REF,
    };

    const { rerender } = renderHook((props) => useMapNodes(props), {
      initialProps: baseProps,
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const layoutCallsAfterInitial = vi.mocked(layoutForAsync).mock.calls.length;
    expect(layoutCallsAfterInitial).toBeGreaterThan(0);

    // Toggling the presentational transition flag must NOT re-run the layout.
    rerender({ ...baseProps, modeTransitionActive: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(vi.mocked(layoutForAsync).mock.calls.length).toBe(
      layoutCallsAfterInitial,
    );
  });
});
