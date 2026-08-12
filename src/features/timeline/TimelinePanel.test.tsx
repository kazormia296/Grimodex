// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { TimelinePanel } from "./TimelinePanel";
import { useTimelineStore } from "./timelineStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

const mockDeleteNode = vi.fn();
const mockOpenPinned = vi.fn();
const mockOpenInSecondaryGroup = vi.fn();
const mockOpenPreview = vi.fn();

vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) =>
      sel({
        openPinned: mockOpenPinned,
        openInSecondaryGroup: mockOpenInSecondaryGroup,
        openPreview: mockOpenPreview,
      }),
    ),
    {
      getState: () => ({
        openPinned: mockOpenPinned,
        openInSecondaryGroup: mockOpenInSecondaryGroup,
        openPreview: mockOpenPreview,
      }),
    },
  ),
}));

vi.mock("@/features/tree/treeStore", () => {
  return {
    useTreeStore: Object.assign(
      vi.fn((sel: (s: unknown) => unknown) =>
        sel({
          nodes: [],
          setActiveScene: vi.fn(),
          updateStoryTime: vi.fn(),
          deleteNode: mockDeleteNode,
        }),
      ),
      { getState: () => ({ setActiveScene: vi.fn() }) },
    ),
  };
});

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) => sel({ showPanel: vi.fn() })),
    { getState: () => ({ showPanel: vi.fn() }) },
  ),
}));

vi.mock("@/features/codex/phaseResolver", () => ({
  computeGlobalSceneOrder: vi.fn(() => new Map()),
}));

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: vi.fn((sel: (s: unknown) => unknown) =>
    sel({ phasesByEntry: {} }),
  ),
}));

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: vi.fn((sel: (s: unknown) => unknown) => sel({ entries: [] })),
}));

vi.mock("fractional-indexing", () => ({
  generateKeyBetween: vi.fn(() => "a0"),
}));

function resetStore() {
  useTimelineStore.setState({
    axisMode: "reading",
    spacingMode: "uniform",
    zoom: 1,
    scrollOffset: 0,
    selectedNodeIds: [],
    inspectorOpen: false,
    pendingEditNodeId: null,
    showThreads: false,
    selectedPlotThreadId: null,
    selectedPlotLinkId: null,
    display: {
      showTitles: true,
      showChapterNumbers: true,
      showPhasePins: false,
      showThreadGaps: false,
      showStructureAnalysis: false,
    },
  });
}

describe("TimelinePanel – isContentEditable keydown ガード (#5)", () => {
  beforeEach(resetStore);

  it("keepalive activity を panel 境界へ反映する", () => {
    const { getByTestId } = render(<TimelinePanel isActive={false} />);
    expect(getByTestId("timeline-panel")).toHaveAttribute(
      "data-is-active",
      "false",
    );
  });

  it("INPUT にフォーカスがある間は Ctrl+= で zoom が変わらない", () => {
    render(<TimelinePanel />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "=",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });

    expect(useTimelineStore.getState().zoom).toBe(1);
    document.body.removeChild(input);
  });

  it("TEXTAREA にフォーカスがある間は Ctrl+- で zoom が変わらない", () => {
    render(<TimelinePanel />);
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "-",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });

    expect(useTimelineStore.getState().zoom).toBe(1);
    document.body.removeChild(ta);
  });

  it("contentEditable 要素にフォーカスがある間は Ctrl+0 で zoom が変わらない", () => {
    render(<TimelinePanel />);
    const div = document.createElement("div");
    div.contentEditable = "true";
    document.body.appendChild(div);
    div.focus();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "0",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });

    expect(useTimelineStore.getState().zoom).toBe(1);
    document.body.removeChild(div);
  });

  it("フォーカスなしの状態では Ctrl+= で zoom が増加する", () => {
    render(<TimelinePanel />);
    // body にフォーカスを戻す (input 系でない)
    (document.activeElement as HTMLElement | null)?.blur?.();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "=",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });

    expect(useTimelineStore.getState().zoom).toBeGreaterThan(1);
  });
});

describe("TimelinePanel – plain-key shortcuts (#3)", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockTreeWith([]);
    // プロットストアのデータをクリア（テスト間の links/branches リークで
    // 「空スレッド = 即削除」判定がずれるのを防ぐ）。
    usePlotThreadStore.setState({ threads: [], links: [], branches: [] });
  });

  afterEach(() => {
    mockTreeWith([]);
  });

  it("panel focused → Escape clears selection", () => {
    useTimelineStore.setState({ selectedNodeIds: ["s1"] });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(useTimelineStore.getState().selectedNodeIds).toEqual([]);
  });

  it("panel not focused → Escape does NOT clear selection", () => {
    useTimelineStore.setState({ selectedNodeIds: ["s1"] });
    render(<TimelinePanel />);
    const outside = document.createElement("div");
    outside.setAttribute("tabindex", "-1");
    document.body.appendChild(outside);
    act(() => {
      outside.focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(useTimelineStore.getState().selectedNodeIds).toEqual(["s1"]);
    document.body.removeChild(outside);
  });

  it("panel focused → '1' sets axisMode to reading", () => {
    useTimelineStore.setState({
      axisMode: "story",
      spacingMode: "proportional",
    });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "1", bubbles: true }),
      );
    });
    expect(useTimelineStore.getState().axisMode).toBe("reading");
  });

  it("panel focused → '2' sets axisMode to story", () => {
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "2", bubbles: true }),
      );
    });
    expect(useTimelineStore.getState().axisMode).toBe("story");
  });

  it("panel focused → '3' sets axisMode to write", () => {
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "3", bubbles: true }),
      );
    });
    expect(useTimelineStore.getState().axisMode).toBe("write");
  });

  it("panel focused + selected → Delete calls deleteNode with first selected id", () => {
    useTimelineStore.setState({ selectedNodeIds: ["scene-x"] });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    expect(mockDeleteNode).toHaveBeenCalledWith("scene-x");
  });

  it("panel focused + multiple selected → Delete calls deleteNode for each id", () => {
    useTimelineStore.setState({ selectedNodeIds: ["s1", "s2"] });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    expect(mockDeleteNode).toHaveBeenCalledWith("s1");
    expect(mockDeleteNode).toHaveBeenCalledWith("s2");
    expect(mockDeleteNode).toHaveBeenCalledTimes(2);
  });

  it("プロット(スレッド/マーカー)選択中の Delete はシーンを消さない", () => {
    const threadSpy = vi
      .spyOn(usePlotThreadStore.getState(), "deleteThread")
      .mockResolvedValue(undefined);
    useTimelineStore.setState({
      selectedNodeIds: ["scene-x"],
      showThreads: true,
      selectedPlotThreadId: "t1",
      selectedPlotLinkId: null,
    });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    expect(mockDeleteNode).not.toHaveBeenCalled();
    threadSpy.mockRestore();
  });

  it("panel focused + マーカー選択中 → Delete でそのマーカーを削除し選択解除", () => {
    const spy = vi
      .spyOn(usePlotThreadStore.getState(), "deleteMarker")
      .mockResolvedValue(undefined);
    useTimelineStore.setState({
      showThreads: true,
      selectedPlotLinkId: "link-1",
      selectedPlotThreadId: null,
    });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    expect(spy).toHaveBeenCalledWith("link-1");
    expect(useTimelineStore.getState().selectedPlotLinkId).toBeNull();
    spy.mockRestore();
  });

  it("マーカー選択中の Delete はシーンを消さない", () => {
    const spy = vi
      .spyOn(usePlotThreadStore.getState(), "deleteMarker")
      .mockResolvedValue(undefined);
    useTimelineStore.setState({
      selectedNodeIds: ["scene-x"],
      showThreads: true,
      selectedPlotLinkId: "link-1",
      selectedPlotThreadId: null,
    });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    expect(mockDeleteNode).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("スレッドのみ選択中（マーカー非選択）の Delete はマーカーを消さない", () => {
    const spy = vi
      .spyOn(usePlotThreadStore.getState(), "deleteMarker")
      .mockResolvedValue(undefined);
    const threadSpy = vi
      .spyOn(usePlotThreadStore.getState(), "deleteThread")
      .mockResolvedValue(undefined);
    useTimelineStore.setState({
      showThreads: true,
      selectedPlotThreadId: "t1",
      selectedPlotLinkId: null,
    });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    threadSpy.mockRestore();
  });

  it("中身のないスレッドのみ選択中 → Delete は確認なしで即削除し選択解除", () => {
    const spy = vi
      .spyOn(usePlotThreadStore.getState(), "deleteThread")
      .mockResolvedValue(undefined);
    // links/branches は空（beforeEach でクリア済）= 中身なし。
    useTimelineStore.setState({
      showThreads: true,
      selectedPlotThreadId: "t1",
      selectedPlotLinkId: null,
    });
    const { getByTestId, queryByText } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    expect(spy).toHaveBeenCalledWith("t1");
    expect(useTimelineStore.getState().selectedPlotThreadId).toBeNull();
    expect(queryByText("削除する")).toBeNull(); // 確認 DLG は出ない
    spy.mockRestore();
  });

  it("シーン+空スレッド共存中の Delete 連打でシーンを消さない（回帰）", () => {
    // 回帰: 空スレッド即削除が選択を中途半端にクリアし、次の Delete が
    // 残ったシーン選択を消していた。clearSelection で全クリアし防ぐ。
    const threadSpy = vi
      .spyOn(usePlotThreadStore.getState(), "deleteThread")
      .mockResolvedValue(undefined);
    useTimelineStore.setState({
      selectedNodeIds: ["scene-x"],
      showThreads: true,
      selectedPlotThreadId: "t1",
      selectedPlotLinkId: null,
    });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    // 1回目: 空スレッド t1 を即削除し、選択を全クリア。
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    expect(threadSpy).toHaveBeenCalledWith("t1");
    expect(useTimelineStore.getState().selectedNodeIds).toEqual([]);
    // 2回目（別押下・e.repeat=false）: 選択は全クリア済 → シーン削除に落ちない。
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    expect(mockDeleteNode).not.toHaveBeenCalled();
    threadSpy.mockRestore();
  });

  it("Delete のオートリピート(e.repeat)は破壊的削除を起こさない", () => {
    const threadSpy = vi
      .spyOn(usePlotThreadStore.getState(), "deleteThread")
      .mockResolvedValue(undefined);
    useTimelineStore.setState({
      selectedNodeIds: ["scene-x"],
      showThreads: true,
      selectedPlotThreadId: "t1",
      selectedPlotLinkId: null,
    });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Delete",
          repeat: true,
          bubbles: true,
        }),
      );
    });
    expect(threadSpy).not.toHaveBeenCalled();
    expect(mockDeleteNode).not.toHaveBeenCalled();
    threadSpy.mockRestore();
  });

  it("中身のあるスレッド選択中 → Delete は確認 DLG を出し、確定で削除し選択解除", () => {
    const spy = vi
      .spyOn(usePlotThreadStore.getState(), "deleteThread")
      .mockResolvedValue(undefined);
    // t1 にマーカー(l1)を持たせる＝中身あり → 確認を挟む。
    usePlotThreadStore.setState({
      threads: [
        {
          id: "t1",
          projectId: "p1",
          name: "主筋",
          color: null,
          description: null,
          sortOrder: "a0",
          startNodeId: null,
          endNodeId: null,
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      links: [
        {
          id: "l1",
          threadId: "t1",
          nodeId: "s1",
          phaseType: "develop",
          note: null,
          sortOrder: null,
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      branches: [],
    });
    useTimelineStore.setState({
      showThreads: true,
      selectedPlotThreadId: "t1",
      selectedPlotLinkId: null,
    });
    const { getByTestId, getByText, queryByText } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    // 確認 DLG が出る間は未削除・選択も保持。
    expect(spy).not.toHaveBeenCalled();
    expect(useTimelineStore.getState().selectedPlotThreadId).toBe("t1");
    // 「削除する」確定で実削除＋選択解除＋DLG クローズ。
    act(() => {
      fireEvent.click(getByText("削除する"));
    });
    expect(spy).toHaveBeenCalledWith("t1");
    expect(useTimelineStore.getState().selectedPlotThreadId).toBeNull();
    expect(queryByText("削除する")).toBeNull(); // 確定後 DLG は閉じる
    spy.mockRestore();
  });

  it("分岐/合流のみ持つスレッド（マーカー0）選択中 → Delete も確認 DLG を出す", () => {
    const spy = vi
      .spyOn(usePlotThreadStore.getState(), "deleteThread")
      .mockResolvedValue(undefined);
    // links は空・branches を1件＝markerCount=0, edgeCount=1（merge/branch アンカー）。
    usePlotThreadStore.setState({
      threads: [
        {
          id: "t1",
          projectId: "p1",
          name: "支線",
          color: null,
          description: null,
          sortOrder: "a0",
          startNodeId: null,
          endNodeId: null,
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      links: [],
      branches: [
        {
          id: "b1",
          projectId: "p1",
          fromThreadId: "t2",
          toThreadId: "t1",
          atNodeId: "s1",
          kind: "merge",
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    useTimelineStore.setState({
      showThreads: true,
      selectedPlotThreadId: "t1",
      selectedPlotLinkId: null,
    });
    const { getByTestId, getByText } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    // edge>0 でも確認を挟む（即削除しない）。
    expect(spy).not.toHaveBeenCalled();
    expect(getByText("削除する")).toBeTruthy();
    spy.mockRestore();
  });

  it("中身のあるスレッドの Delete 確認 DLG をキャンセルすると削除しない", () => {
    const spy = vi
      .spyOn(usePlotThreadStore.getState(), "deleteThread")
      .mockResolvedValue(undefined);
    usePlotThreadStore.setState({
      threads: [
        {
          id: "t1",
          projectId: "p1",
          name: "主筋",
          color: null,
          description: null,
          sortOrder: "a0",
          startNodeId: null,
          endNodeId: null,
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      links: [
        {
          id: "l1",
          threadId: "t1",
          nodeId: "s1",
          phaseType: "develop",
          note: null,
          sortOrder: null,
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      branches: [],
    });
    useTimelineStore.setState({
      showThreads: true,
      selectedPlotThreadId: "t1",
      selectedPlotLinkId: null,
    });
    const { getByTestId, getByText, queryByText } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    act(() => {
      fireEvent.click(getByText("キャンセル"));
    });
    expect(spy).not.toHaveBeenCalled();
    expect(useTimelineStore.getState().selectedPlotThreadId).toBe("t1");
    expect(queryByText("削除する")).toBeNull(); // DLG は閉じる
    spy.mockRestore();
  });

  it("panel focused + selected → Enter calls openPinned", () => {
    useTimelineStore.setState({ selectedNodeIds: ["scene-x"] });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(mockOpenPinned).toHaveBeenCalledWith("scene-x");
  });

  it("panel focused + selected + Ctrl+Enter → calls openInSecondaryGroup", () => {
    useTimelineStore.setState({ selectedNodeIds: ["scene-x"] });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    expect(mockOpenInSecondaryGroup).toHaveBeenCalledWith("scene-x");
  });

  it("panel focused + story mode + selected (node exists) → F2 opens inspector", () => {
    mockTreeWith([{ ...mockSceneNodes[0], id: "scene-x" }]);
    useTimelineStore.setState({
      axisMode: "story",
      selectedNodeIds: ["scene-x"],
      inspectorOpen: false,
    });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F2", bubbles: true }),
      );
    });
    // inspectorOpen toggled to true proves F2 fired
    // (pendingEditNodeId may be cleared by TimelineInspector mounting)
    expect(useTimelineStore.getState().inspectorOpen).toBe(true);
  });

  it("panel focused + story mode + selected (node NOT in tree) → F2 does nothing", () => {
    useTimelineStore.setState({
      axisMode: "story",
      selectedNodeIds: ["ghost-id"],
      inspectorOpen: false,
    });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F2", bubbles: true }),
      );
    });
    expect(useTimelineStore.getState().pendingEditNodeId).toBeNull();
    expect(useTimelineStore.getState().inspectorOpen).toBe(false);
  });

  it("panel focused + reading mode → F2 does nothing", () => {
    useTimelineStore.setState({
      axisMode: "reading",
      selectedNodeIds: ["scene-x"],
    });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F2", bubbles: true }),
      );
    });
    expect(useTimelineStore.getState().pendingEditNodeId).toBeNull();
  });

  it("INPUT inside panel focused → '2' does NOT change axisMode", () => {
    const { getByTestId } = render(<TimelinePanel />);
    const panel = getByTestId("timeline-panel");
    const input = document.createElement("input");
    panel.appendChild(input);
    act(() => {
      input.focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "2", bubbles: true }),
      );
    });
    expect(useTimelineStore.getState().axisMode).toBe("reading");
    panel.removeChild(input);
  });
});

const mockSceneNodes: TreeNodeData[] = [
  {
    id: "s1",
    projectId: "p",
    parentId: null,
    nodeType: "scene",
    title: "Scene 1",
    synopsis: null,

    intent: null,
    sortOrder: "a0",
    status: "draft",
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    createdAt: "2024-01-01T00:00:00Z",

    charCount: 0,
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "s2",
    projectId: "p",
    parentId: null,
    nodeType: "scene",
    title: "Scene 2",
    synopsis: null,

    intent: null,
    sortOrder: "a1",
    status: "draft",
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    createdAt: "2024-01-02T00:00:00Z",

    charCount: 0,
    updatedAt: "2024-01-02T00:00:00Z",
  },
  {
    id: "s3",
    projectId: "p",
    parentId: null,
    nodeType: "scene",
    title: "Scene 3",
    synopsis: null,

    intent: null,
    sortOrder: "a2",
    status: "draft",
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    createdAt: "2024-01-03T00:00:00Z",

    charCount: 0,
    updatedAt: "2024-01-03T00:00:00Z",
  },
];

function mockTreeWith(nodes: TreeNodeData[], activeSceneId = "") {
  vi.mocked(useTreeStore).mockImplementation((sel) =>
    (sel as (s: unknown) => unknown)({
      nodes,
      activeSceneId,
      setActiveScene: vi.fn(),
      updateStoryTime: vi.fn(),
      deleteNode: mockDeleteNode,
    }),
  );
}

describe("TimelinePanel – arrow key navigation (#3)", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockTreeWith(mockSceneNodes);
  });

  afterEach(() => {
    mockTreeWith([]);
  });

  it("ArrowRight advances selection", () => {
    useTimelineStore.setState({ selectedNodeIds: ["s1"] });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(useTimelineStore.getState().selectedNodeIds).toEqual(["s2"]);
  });

  it("ArrowLeft retreats selection", () => {
    useTimelineStore.setState({ selectedNodeIds: ["s2"] });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    });
    expect(useTimelineStore.getState().selectedNodeIds).toEqual(["s1"]);
  });

  it("ArrowRight with no selection selects first scene", () => {
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(useTimelineStore.getState().selectedNodeIds).toEqual(["s1"]);
  });

  it("ArrowLeft with no selection selects last scene", () => {
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    });
    expect(useTimelineStore.getState().selectedNodeIds).toEqual(["s3"]);
  });

  const plotThread = (id: string, sortOrder: string) => ({
    id,
    projectId: "p",
    name: id,
    color: null,
    description: null,
    sortOrder,
    startNodeId: null,
    endNodeId: null,
    createdAt: "",
    updatedAt: "",
  });
  const plotLink = (id: string, threadId: string, nodeId: string) => ({
    id,
    threadId,
    nodeId,
    phaseType: "develop" as const,
    note: null,
    sortOrder: null,
    semanticKey: "",
    version: 0,
    createdAt: "",
    updatedAt: "",
  });
  const arrow = (key: string) =>
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );
    });

  it("ArrowRight/Left は同スレッド内のマーカーを移動する", () => {
    usePlotThreadStore.setState({
      threads: [plotThread("t1", "a0")],
      links: [plotLink("m1", "t1", "s1"), plotLink("m2", "t1", "s2")],
    });
    useTimelineStore.setState({
      showThreads: true,
      selectedPlotLinkId: "m1",
      selectedPlotThreadId: "t1",
    });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => getByTestId("timeline-panel").focus());
    arrow("ArrowRight");
    expect(useTimelineStore.getState().selectedPlotLinkId).toBe("m2");
    arrow("ArrowLeft");
    expect(useTimelineStore.getState().selectedPlotLinkId).toBe("m1");
  });

  it("ArrowDown は隣スレッドの同じ列のマーカーへ移る", () => {
    usePlotThreadStore.setState({
      threads: [plotThread("t1", "a0"), plotThread("t2", "a1")],
      links: [plotLink("m1", "t1", "s2"), plotLink("m2", "t2", "s2")],
    });
    useTimelineStore.setState({
      showThreads: true,
      selectedPlotLinkId: "m1", // t1 / s2(col1)
      selectedPlotThreadId: "t1",
    });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => getByTestId("timeline-panel").focus());
    arrow("ArrowDown");
    expect(useTimelineStore.getState().selectedPlotLinkId).toBe("m2");
  });

  it("ArrowDown はスレッド表示中に次のスレッドを選択する", () => {
    usePlotThreadStore.setState({
      threads: [plotThread("t1", "a0"), plotThread("t2", "a1")],
      links: [],
    });
    useTimelineStore.setState({
      showThreads: true,
      selectedPlotThreadId: "t1",
      selectedPlotLinkId: null,
    });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(useTimelineStore.getState().selectedPlotThreadId).toBe("t2");
  });

  it("ArrowUp は先頭スレッドで止まる（クランプ）", () => {
    usePlotThreadStore.setState({
      threads: [plotThread("t1", "a0"), plotThread("t2", "a1")],
      links: [],
    });
    useTimelineStore.setState({
      showThreads: true,
      selectedPlotThreadId: "t1",
      selectedPlotLinkId: null,
    });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
    });
    expect(useTimelineStore.getState().selectedPlotThreadId).toBe("t1");
  });

  it("スレッド非表示中は ArrowUp/Down がスレッド選択を変えない", () => {
    usePlotThreadStore.setState({
      threads: [plotThread("t1", "a0"), plotThread("t2", "a1")],
      links: [],
    });
    useTimelineStore.setState({
      showThreads: false,
      selectedPlotThreadId: null,
      selectedPlotLinkId: null,
    });
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(useTimelineStore.getState().selectedPlotThreadId).toBeNull();
  });

  it("Shift+ArrowRight extends selection range", () => {
    useTimelineStore.getState().selectNode("s1");
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    const ids = useTimelineStore.getState().selectedNodeIds;
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
  });

  it("Shift+ArrowRight then Shift+ArrowLeft reverses range (anchor stays at s2)", () => {
    useTimelineStore.getState().selectNode("s2");
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    // Extend forward: s2 → s3
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(useTimelineStore.getState().selectedNodeIds).toContain("s3");
    // Reverse: anchor s2, extend back to s1 → {s1, s2}
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowLeft",
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    const ids = useTimelineStore.getState().selectedNodeIds;
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
    expect(ids).not.toContain("s3");
  });
});

describe("TimelinePanel – active scene ring (現在地マーカー)", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockTreeWith([]);
  });

  it("activeSceneId と一致する scene の dot に外側リングが描画される", () => {
    mockTreeWith(mockSceneNodes, "s2");
    const { container } = render(<TimelinePanel />);
    // Ring is a stroke-only circle with stroke="var(--primary)"
    const rings = container.querySelectorAll(
      'circle[stroke="var(--primary)"][fill="none"]',
    );
    expect(rings.length).toBe(1);
  });

  it("activeSceneId が空ならリングは描画されない", () => {
    mockTreeWith(mockSceneNodes, "");
    const { container } = render(<TimelinePanel />);
    const rings = container.querySelectorAll(
      'circle[stroke="var(--primary)"][fill="none"]',
    );
    expect(rings.length).toBe(0);
  });

  it("activeSceneId が nodes に無い場合もリングは描画されない", () => {
    mockTreeWith(mockSceneNodes, "scene-deleted");
    const { container } = render(<TimelinePanel />);
    const rings = container.querySelectorAll(
      'circle[stroke="var(--primary)"][fill="none"]',
    );
    expect(rings.length).toBe(0);
  });
});

describe("TimelinePanel – scenes モードのインスペクタ表示", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockTreeWith(mockSceneNodes);
  });

  afterEach(() => {
    mockTreeWith([]);
  });

  it("インスペクタを開けば未選択でもパネルが出る（プレースホルダー）", () => {
    useTimelineStore.setState({
      selectedPlotLinkId: null,
      selectedPlotThreadId: null,
      inspectorOpen: true,
      selectedNodeIds: [],
    });
    const { getByTestId, getByText } = render(<TimelinePanel />);
    expect(getByTestId("timeline-inspector")).toBeTruthy();
    expect(getByText("シーンを選択すると詳細が表示されます")).toBeTruthy();
  });

  it("シーン選択中はプレースホルダーではなく詳細が出る", () => {
    useTimelineStore.setState({
      selectedPlotLinkId: null,
      selectedPlotThreadId: null,
      inspectorOpen: true,
      selectedNodeIds: ["s1"],
    });
    const { getByTestId, queryByText } = render(<TimelinePanel />);
    expect(getByTestId("timeline-inspector")).toBeTruthy();
    expect(queryByText("シーンを選択すると詳細が表示されます")).toBeNull();
  });

  it("インスペクタを閉じていればパネルは出ない", () => {
    useTimelineStore.setState({
      selectedPlotLinkId: null,
      selectedPlotThreadId: null,
      inspectorOpen: false,
      selectedNodeIds: ["s1"],
    });
    const { queryByTestId } = render(<TimelinePanel />);
    expect(queryByTestId("timeline-inspector")).toBeNull();
  });

  it("シングルクリックは選択のみ（設計書準拠：インスペクタは自動オープンしない）", () => {
    useTimelineStore.setState({
      selectedPlotLinkId: null,
      selectedPlotThreadId: null,
      inspectorOpen: false,
      selectedNodeIds: [],
    });
    const { container } = render(<TimelinePanel />);
    const dot = [...container.querySelectorAll("circle")].find(
      (c) => c.querySelector("title")?.textContent === "Scene 1",
    );
    expect(dot).toBeTruthy();
    act(() => {
      fireEvent.click(dot!);
    });
    // 選択 + プレビュータブで開く。インスペクタは開かない（⋮ で明示オープン）。
    expect(useTimelineStore.getState().selectedNodeIds).toEqual(["s1"]);
    expect(mockOpenPreview).toHaveBeenCalledWith("s1");
    expect(useTimelineStore.getState().inspectorOpen).toBe(false);
  });
});

describe("TimelinePanel – インスペクタのルーティング（オーバーレイ）", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockTreeWith(mockSceneNodes);
  });
  afterEach(() => {
    mockTreeWith([]);
  });

  it("スレッド表示中にマーカー選択でプロット用インスペクタが出る", () => {
    useTimelineStore.setState({
      showThreads: true,
      inspectorOpen: true,
      selectedPlotLinkId: "l1",
      selectedPlotThreadId: null,
    });
    const { getByTestId, queryByTestId } = render(<TimelinePanel />);
    expect(getByTestId("plot-marker-inspector")).toBeTruthy();
    expect(queryByTestId("timeline-inspector")).toBeNull();
  });

  it("スレッド非表示ならプロット選択が残ってもシーン用インスペクタに戻る", () => {
    useTimelineStore.setState({
      showThreads: false,
      inspectorOpen: true,
      selectedPlotLinkId: "l1",
      selectedPlotThreadId: null,
    });
    const { getByTestId, queryByTestId } = render(<TimelinePanel />);
    expect(getByTestId("timeline-inspector")).toBeTruthy();
    expect(queryByTestId("plot-marker-inspector")).toBeNull();
  });
});

describe("TimelinePanel – Ctrl+矢印パン（ホイール/中ボタンのキーボード代替）", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockTreeWith(mockSceneNodes);
  });
  afterEach(() => {
    mockTreeWith([]);
  });

  function panKey(key: string) {
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }),
      );
    });
  }

  it("panel focused → Ctrl+ArrowRight/Left で横パンする", () => {
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    const viewport = getByTestId("timeline-scroll-container");
    viewport.scrollLeft = 200;
    panKey("ArrowRight");
    expect(viewport.scrollLeft).toBe(280);
    panKey("ArrowLeft");
    expect(viewport.scrollLeft).toBe(200);
  });

  it("panel focused → Ctrl+ArrowDown/Up で縦パンする", () => {
    const { getByTestId } = render(<TimelinePanel />);
    act(() => {
      getByTestId("timeline-panel").focus();
    });
    const viewport = getByTestId("timeline-scroll-container");
    viewport.scrollTop = 200;
    panKey("ArrowDown");
    expect(viewport.scrollTop).toBe(280);
    panKey("ArrowUp");
    expect(viewport.scrollTop).toBe(200);
  });

  it("panel 外フォーカスでは Ctrl+ArrowRight でパンしない", () => {
    const { getByTestId } = render(<TimelinePanel />);
    const outside = document.createElement("div");
    outside.setAttribute("tabindex", "-1");
    document.body.appendChild(outside);
    act(() => {
      outside.focus();
    });
    const viewport = getByTestId("timeline-scroll-container");
    viewport.scrollLeft = 200;
    panKey("ArrowRight");
    expect(viewport.scrollLeft).toBe(200);
    document.body.removeChild(outside);
  });

  it("INPUT フォーカス中は Ctrl+ArrowRight でパンしない", () => {
    const { getByTestId } = render(<TimelinePanel />);
    const panel = getByTestId("timeline-panel");
    const input = document.createElement("input");
    panel.appendChild(input);
    act(() => {
      input.focus();
    });
    const viewport = getByTestId("timeline-scroll-container");
    viewport.scrollLeft = 200;
    panKey("ArrowRight");
    expect(viewport.scrollLeft).toBe(200);
    panel.removeChild(input);
  });
});
