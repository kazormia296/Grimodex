// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Node } from "@xyflow/react";

import {
  corkRotation,
  countStickiesByBranch,
  mapNodePresentationEqual,
  useMapNodes,
} from "./useMapNodes";
import { layoutForAsync } from "../layouts";
import { layoutFingerprint } from "../layouts/layoutFingerprint";
import type { MapNodePositionRecord } from "../types";
import { projectMapPositions } from "./mapPositionProjection";

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

describe("map node incremental rebuild helpers", () => {
  it("counts branch stickies in one pass", () => {
    const counts = countStickiesByBranch([
      { id: "s1", aiBranchId: "b1" },
      { id: "s2", aiBranchId: "b1" },
      { id: "s3", aiBranchId: "b2" },
      { id: "s4", aiBranchId: null },
    ] as unknown as Parameters<typeof countStickiesByBranch>[0]);

    expect(counts).toEqual(
      new Map([
        ["b1", 2],
        ["b2", 1],
      ]),
    );
  });

  it("preserves identity when only rebuilt callback references differ", () => {
    const previous: Node = {
      id: "scene:s1",
      type: "scene",
      position: { x: 10, y: 20 },
      data: { title: "Scene", onOpen: () => "old" },
    };
    const rebuilt: Node = {
      ...previous,
      data: { title: "Scene", onOpen: () => "new" },
    };

    expect(mapNodePresentationEqual(previous, rebuilt)).toBe(true);
    expect(
      mapNodePresentationEqual(previous, {
        ...rebuilt,
        data: { ...rebuilt.data, title: "Changed" },
      }),
    ).toBe(false);
  });
});

describe("useMapNodes — reused node callbacks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("node identity を維持したまま最新の onBranchFrom を呼ぶ", async () => {
    let nodes: Node[] = [];
    const setNodes = vi.fn((update: React.SetStateAction<Node[]>) => {
      nodes = typeof update === "function" ? update(nodes) : update;
    });
    const firstOnBranchFrom = vi.fn();
    const latestOnBranchFrom = vi.fn();
    const positions = [makePosition("pos1", "s1")];
    const treeNodes = [
      {
        id: "s1",
        nodeType: "scene",
        title: "Scene",
        synopsis: null,
        status: "outline",
        sortOrder: "a0",
      },
    ] as Parameters<typeof useMapNodes>[0]["treeNodes"];
    const baseProps: Parameters<typeof useMapNodes>[0] = {
      boardId: "b1",
      positions,
      positionsStructureRevision: 1,
      positionsLayoutRevision: 1,
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
        userEdges: false,
        derivedEdges: false,
        stickies: false,
        aiBranch: false,
        frames: false,
        snippets: false,
      },
      mode: "free",
      userEdges: [],
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
      groupDraggingRef: NOOP_REF,
      persistingRef: NOOP_REF,
      onBranchFrom: firstOnBranchFrom,
    };

    const { rerender } = renderHook((props) => useMapNodes(props), {
      initialProps: baseProps,
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const originalNode = nodes[0];

    rerender({ ...baseProps, onBranchFrom: latestOnBranchFrom });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(nodes[0]).toBe(originalNode);
    (nodes[0].data.onBranchFrom as (direction: "left" | "right") => void)(
      "right",
    );
    expect(firstOnBranchFrom).not.toHaveBeenCalled();
    expect(latestOnBranchFrom).toHaveBeenCalledWith("scene:s1", "right");
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
  applyPinnedOverrides: vi.fn(
    (computed: Map<string, { x: number; y: number }>) => computed,
  ),
}));

vi.mock("../layouts/layoutFingerprint", () => ({
  layoutFingerprint: vi.fn().mockReturnValue("fp-1"),
  computeLayoutFingerprint: vi.fn().mockReturnValue("fp-1"),
}));

vi.mock("./mapPositionProjection", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./mapPositionProjection")>();
  return {
    ...actual,
    projectMapPositions: vi.fn(actual.projectMapPositions),
  };
});

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

function makePosition(
  id: string,
  treeNodeId: string,
  overrides: Partial<MapNodePositionRecord> = {},
): MapNodePositionRecord {
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
    ...overrides,
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
        positionsStructureRevision: 1,
        positionsLayoutRevision: 1,
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
        userEdges: [],
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
      positionsStructureRevision: 1,
      positionsLayoutRevision: 1,
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
      userEdges: [],
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

  it("force layout が reject しても setForceLayoutRunning(false) が呼ばれる", async () => {
    // 防御深化: theme worker が "node not found" 等で reject した時、buildNodes
    // を fire-and-forget で投げっぱなしにすると forceLayoutRunning が true で
    // 永続化し、進捗バーが消えずノードもドラッグ不能になる。.catch で必ず
    // 復帰させていることを確認する。
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(layoutForAsync).mockRejectedValueOnce(new Error("worker failed"));
    const setForceLayoutRunning = vi.fn();

    const props: Parameters<typeof useMapNodes>[0] = {
      boardId: "b1",
      positions: [],
      positionsStructureRevision: 1,
      positionsLayoutRevision: 1,
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
      userEdges: [],
      colorBy: "none" as const,
      visualTheme: "default",
      modeTransitionActive: false,
      setFrames: vi.fn(),
      setStickies: vi.fn(),
      setAiBranches: vi.fn(),
      setPositions: vi.fn(),
      setNodes: vi.fn(),
      setForceLayoutRunning,
      setForceAlpha: vi.fn(),
      updateNodeTitle: vi.fn(),
      updateSynopsis: vi.fn(),
      setActiveScene: vi.fn(),
      groupDraggingRef: NOOP_REF,
      persistingRef: NOOP_REF,
    };

    renderHook(() => useMapNodes(props));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // (true で始まり, reject 後 false で復帰しているはず)
    expect(setForceLayoutRunning).toHaveBeenCalledWith(true);
    expect(setForceLayoutRunning).toHaveBeenCalledWith(false);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("fingerprint 不変時は layoutForAsync を再呼び出ししない", async () => {
    vi.mocked(layoutFingerprint).mockReturnValue("stable-fp");

    const baseProps: Parameters<typeof useMapNodes>[0] = {
      boardId: "b1",
      positions: [makePosition("pos1", "s1")],
      positionsStructureRevision: 1,
      positionsLayoutRevision: 1,
      treeNodes: [
        {
          id: "s1",
          nodeType: "scene",
          title: "Scene",
          synopsis: null,
          status: "outline",
          sortOrder: "a0",
        },
      ] as Parameters<typeof useMapNodes>[0]["treeNodes"],
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
      userEdges: [],
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

    const callsAfterInitial = vi.mocked(layoutForAsync).mock.calls.length;
    const fingerprintCallsAfterInitial =
      vi.mocked(layoutFingerprint).mock.calls.length;
    const projectionCallsAfterInitial =
      vi.mocked(projectMapPositions).mock.calls.length;
    const nodeBuildsAfterInitial = vi.mocked(baseProps.setNodes).mock.calls
      .length;
    expect(callsAfterInitial).toBe(1);

    rerender({
      ...baseProps,
      positions: [makePosition("pos1", "s1", { x: 999, y: 888 })],
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(vi.mocked(layoutForAsync).mock.calls.length).toBe(callsAfterInitial);
    expect(vi.mocked(layoutFingerprint).mock.calls.length).toBe(
      fingerprintCallsAfterInitial,
    );
    expect(vi.mocked(projectMapPositions).mock.calls.length).toBe(
      projectionCallsAfterInitial,
    );
    expect(vi.mocked(baseProps.setNodes).mock.calls.length).toBe(
      nodeBuildsAfterInitial,
    );
  });

  it("structure revision の更新は projection と theme layout を再構築する", async () => {
    vi.mocked(layoutFingerprint).mockImplementation(({ scenes }) =>
      scenes
        .map((scene) => scene.id)
        .sort()
        .join("|"),
    );
    let nodes: Node[] = [];
    const setNodes = vi.fn((update: React.SetStateAction<Node[]>) => {
      nodes = typeof update === "function" ? update(nodes) : update;
    });
    const scene = (id: string, sortOrder: string) =>
      ({
        id,
        nodeType: "scene",
        title: id,
        synopsis: null,
        status: "outline",
        sortOrder,
      }) as Parameters<typeof useMapNodes>[0]["treeNodes"][number];
    const baseProps: Parameters<typeof useMapNodes>[0] = {
      boardId: "b1",
      positions: [makePosition("pos1", "s1")],
      positionsStructureRevision: 1,
      positionsLayoutRevision: 1,
      treeNodes: [scene("s1", "a0")],
      codexEntries: [],
      snippets: [],
      stickies: [],
      aiBranches: [],
      frames: [],
      show: {
        scenes: true,
        codex: false,
        notes: false,
        userEdges: false,
        derivedEdges: false,
        stickies: false,
        aiBranch: false,
        frames: false,
        snippets: false,
      },
      mode: "theme",
      userEdges: [],
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
      groupDraggingRef: NOOP_REF,
      persistingRef: NOOP_REF,
    };

    const { rerender } = renderHook((props) => useMapNodes(props), {
      initialProps: baseProps,
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const fingerprintCallsAfterInitial =
      vi.mocked(layoutFingerprint).mock.calls.length;
    const projectionCallsAfterInitial =
      vi.mocked(projectMapPositions).mock.calls.length;
    const layoutCallsAfterInitial = vi.mocked(layoutForAsync).mock.calls.length;

    rerender({
      ...baseProps,
      positions: [makePosition("pos1", "s1"), makePosition("pos2", "s2")],
      positionsStructureRevision: 2,
      positionsLayoutRevision: 2,
      treeNodes: [scene("s1", "a0"), scene("s2", "a1")],
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(vi.mocked(layoutFingerprint).mock.calls.length).toBeGreaterThan(
      fingerprintCallsAfterInitial,
    );
    expect(vi.mocked(projectMapPositions).mock.calls.length).toBeGreaterThan(
      projectionCallsAfterInitial,
    );
    expect(vi.mocked(layoutForAsync).mock.calls.length).toBeGreaterThan(
      layoutCallsAfterInitial,
    );
    expect(nodes.map((node) => node.id)).toEqual(["scene:s1", "scene:s2"]);
  });
});

// ── userEdges 参照安定性に依存する契約の固定 ─────────────────────────────
//
// MapCanvas 側で `userEdges.map((e) => ({...}))` を毎レンダリングで生成して
// 渡すと、本フックの buildNodes effect が `userEdges` 参照変化で毎フレーム
// 走り、setNodes → 再レンダリング → 新 .map() の無限ループとなる
// (Maximum update depth exceeded)。回避は MapCanvas 側で useMemo 化する
// しかないため、本テストは「親が安定参照を渡してきた場合は再実行しない」
// という契約を固定する。MapCanvas で useMemo が剥がれたら、本フックは
// 防御しきれないことの明示でもある。
describe("useMapNodes — userEdges 参照安定時は再構築しない契約", () => {
  beforeEach(() => vi.clearAllMocks());

  it("同一参照の userEdges で rerender しても setNodes を追加で呼ばない", async () => {
    vi.mocked(layoutFingerprint).mockReturnValue("stable-fp");
    const setNodes = vi.fn();

    const positions = [makePosition("pos1", "s1")];
    const treeNodes = [
      {
        id: "s1",
        nodeType: "scene",
        title: "Scene",
        synopsis: null,
        status: "outline",
        sortOrder: "a0",
      },
    ] as Parameters<typeof useMapNodes>[0]["treeNodes"];

    // Critical: a single, stable userEdges reference reused across renders.
    // Mirrors what MapCanvas's useMemo guarantees.
    const stableUserEdges = [{ fromPositionId: "pos1", toPositionId: "pos1" }];

    const baseProps: Parameters<typeof useMapNodes>[0] = {
      boardId: "b1",
      positions,
      positionsStructureRevision: 1,
      positionsLayoutRevision: 1,
      treeNodes,
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
      mode: "free",
      userEdges: stableUserEdges,
      colorBy: "none" as const,
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
    };

    const { rerender } = renderHook((props) => useMapNodes(props), {
      initialProps: baseProps,
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const setNodesCallsAfterInitial = setNodes.mock.calls.length;
    expect(setNodesCallsAfterInitial).toBeGreaterThan(0);

    // Rerender with the SAME object identity for userEdges. No effect re-run
    // should happen, so setNodes must not be called again.
    rerender({ ...baseProps, userEdges: stableUserEdges });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(setNodes.mock.calls.length).toBe(setNodesCallsAfterInitial);
  });

  it("内容同一でも参照が変わると effect が再実行する (= 親 memo が必須)", async () => {
    // This pins the contract from the other direction: the hook compares
    // `userEdges` by reference (Object.is), so a fresh array of the same
    // shape WILL re-trigger the build. That is exactly the loop trigger that
    // bit MapCanvas pre-fix; this test fails if someone "fixes" the hook to
    // deep-compare and silently lets the parent regress.
    vi.mocked(layoutFingerprint).mockReturnValue("stable-fp");
    const setNodes = vi.fn();

    const baseProps: Parameters<typeof useMapNodes>[0] = {
      boardId: "b1",
      positions: [],
      positionsStructureRevision: 1,
      positionsLayoutRevision: 1,
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
      mode: "free",
      userEdges: [{ fromPositionId: "a", toPositionId: "b" }],
      colorBy: "none" as const,
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
    };

    const { rerender } = renderHook((props) => useMapNodes(props), {
      initialProps: baseProps,
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const callsAfterInitial = setNodes.mock.calls.length;

    // Fresh reference, identical content — triggers the deps comparison
    // and re-runs buildNodes.
    rerender({
      ...baseProps,
      userEdges: [{ fromPositionId: "a", toPositionId: "b" }],
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(setNodes.mock.calls.length).toBeGreaterThan(callsAfterInitial);
  });
});
