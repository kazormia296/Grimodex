// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { TimelinePanel } from "./TimelinePanel";
import { useTimelineStore } from "./timelineStore";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

const mockDeleteNode = vi.fn();
const mockOpenPinned = vi.fn();
const mockOpenInSecondaryGroup = vi.fn();

vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) =>
      sel({
        openPinned: mockOpenPinned,
        openInSecondaryGroup: mockOpenInSecondaryGroup,
      }),
    ),
    {
      getState: () => ({
        openPinned: mockOpenPinned,
        openInSecondaryGroup: mockOpenInSecondaryGroup,
      }),
    },
  ),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: vi.fn((sel: (s: unknown) => unknown) =>
    sel({
      nodes: [],
      setActiveScene: vi.fn(),
      updateStoryTime: vi.fn(),
      deleteNode: mockDeleteNode,
    }),
  ),
}));

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) => sel({ dockviewApi: null })),
    { getState: () => ({ dockviewApi: null }) },
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
    display: {
      showTitles: true,
      showChapterNumbers: true,
      showPhasePins: false,
    },
  });
}

describe("TimelinePanel – isContentEditable keydown ガード (#5)", () => {
  beforeEach(resetStore);

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
    sortOrder: "a0",
    status: "draft",
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    createdAt: "2024-01-01T00:00:00Z",

    charCount: 0,
    unplacedBeatPreview: null,
    placedBeatPreview: null,
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "s2",
    projectId: "p",
    parentId: null,
    nodeType: "scene",
    title: "Scene 2",
    synopsis: null,
    sortOrder: "a1",
    status: "draft",
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    createdAt: "2024-01-02T00:00:00Z",

    charCount: 0,
    unplacedBeatPreview: null,
    placedBeatPreview: null,
    updatedAt: "2024-01-02T00:00:00Z",
  },
  {
    id: "s3",
    projectId: "p",
    parentId: null,
    nodeType: "scene",
    title: "Scene 3",
    synopsis: null,
    sortOrder: "a2",
    status: "draft",
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    createdAt: "2024-01-03T00:00:00Z",

    charCount: 0,
    unplacedBeatPreview: null,
    placedBeatPreview: null,
    updatedAt: "2024-01-03T00:00:00Z",
  },
];

function mockTreeWith(nodes: TreeNodeData[]) {
  vi.mocked(useTreeStore).mockImplementation((sel) =>
    (sel as (s: unknown) => unknown)({
      nodes,
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
