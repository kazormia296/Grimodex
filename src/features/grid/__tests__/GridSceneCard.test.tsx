// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { GridDisplaySettings } from "../gridStore";

const { mockOpenPreview, mockOpenPinned, mockSetActiveScene } = vi.hoisted(
  () => ({
    mockOpenPreview: vi.fn(),
    mockOpenPinned: vi.fn(),
    mockSetActiveScene: vi.fn(),
  }),
);

// --- dnd-kit stubs ---
vi.mock("@dnd-kit/core", () => ({
  useDraggable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  })),
  useDroppable: vi.fn(() => ({ setNodeRef: vi.fn(), isOver: false })),
}));

// --- store stubs ---
vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: {
    getState: vi.fn(() => ({
      openPinned: mockOpenPinned,
      openPreview: mockOpenPreview,
    })),
  },
}));
vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: { getState: vi.fn(() => ({ showPanel: vi.fn() })) },
}));
vi.mock("@/features/codex/sceneCodexPinsStore", () => ({
  useSceneCodexPinsStore: vi.fn(
    (
      sel: (s: {
        pinsByScene: Record<string, string[]>;
        loadPinsForScene: () => Promise<void>;
      }) => unknown,
    ) =>
      sel({
        pinsByScene: {},
        loadPinsForScene: vi.fn().mockResolvedValue(undefined),
      }),
  ),
}));
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: vi.fn((sel: (s: { entries: unknown[] }) => unknown) =>
    sel({ entries: [] }),
  ),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: Object.assign(
    vi.fn(
      (
        sel: (s: {
          pendingRenameId: string | null;
          charCounts: Record<string, number>;
        }) => unknown,
      ) => sel({ pendingRenameId: null, charCounts: {} }),
    ),
    {
      getState: vi.fn(() => ({
        pendingRenameId: null,
        charCounts: {},
        setPendingRenameId: vi.fn(),
        setActiveScene: mockSetActiveScene,
      })),
    },
  ),
  useNodeBeatPreview: vi.fn(() => ({ placed: null, unplaced: null })),
}));

import { useDraggable } from "@dnd-kit/core";
import { useTreeStore, useNodeBeatPreview } from "@/features/tree/treeStore";

const mockUseDraggable = vi.mocked(useDraggable);
const mockTreeStore = useTreeStore as unknown as {
  mockImplementation: (
    fn: (
      selector: (s: {
        pendingRenameId: string | null;
        charCounts: Record<string, number>;
      }) => unknown,
    ) => unknown,
  ) => void;
};
const mockUseNodeBeatPreview = vi.mocked(useNodeBeatPreview);

// --- component under test (imported after mocks) ---
import { GridSceneCard } from "../GridSceneCard";
import { useGridStore } from "../gridStore";

const DEFAULT_DISPLAY: GridDisplaySettings = {
  showSynopsis: true,
  showBeats: true,
  showCodex: true,
  showStatusLabel: true,
  showLabelBar: true,
  showForeshadow: true,
  compactCards: false,
};

function makeScene(overrides: Partial<TreeNodeData> = {}): TreeNodeData {
  return {
    id: "scene-1",
    projectId: "proj-1",
    title: "Test Scene",
    nodeType: "scene",
    parentId: "folder-1",
    sortOrder: "a0",
    synopsis: null,

    intent: null,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useGridStore.getState().clearSelection();
  mockUseNodeBeatPreview.mockReturnValue({ placed: null, unplaced: null });
  mockUseDraggable.mockReturnValue({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    setActivatorNodeRef: vi.fn(),
    isDragging: false,
    transform: null,
    node: { current: null },
    active: null,
    over: null,
    activatorEvent: null,
    activeNodeRect: null,
  } as unknown as ReturnType<typeof useDraggable>);
});

describe("GridSceneCard", () => {
  it("renders scene title", () => {
    render(
      <GridSceneCard
        scene={makeScene({ title: "My Scene" })}
        display={DEFAULT_DISPLAY}
      />,
    );
    expect(screen.getByText("My Scene")).toBeDefined();
  });

  it("shows synopsis when present and showSynopsis=true", () => {
    render(
      <GridSceneCard
        scene={makeScene({ synopsis: "A dark and stormy night" })}
        display={DEFAULT_DISPLAY}
      />,
    );
    expect(screen.getByText("A dark and stormy night")).toBeDefined();
  });

  it("shows 'empty scene' placeholder when showSynopsis=false and no beats", () => {
    render(
      <GridSceneCard
        scene={makeScene({ synopsis: null })}
        display={{ ...DEFAULT_DISPLAY, showSynopsis: false, showBeats: false }}
      />,
    );
    expect(screen.getByText("空のシーン")).toBeDefined();
  });

  it("shows beat bullets when synopsis empty but beats present", () => {
    const preview = JSON.stringify(["Beat one", "Beat two"]);
    mockUseNodeBeatPreview.mockReturnValue({ placed: null, unplaced: preview });
    render(
      <GridSceneCard
        scene={makeScene({ synopsis: null })}
        display={DEFAULT_DISPLAY}
      />,
    );
    expect(screen.getByText("Beat one")).toBeDefined();
    expect(screen.getByText("Beat two")).toBeDefined();
  });

  it("renders without crashing when unplacedBeatPreview is malformed", () => {
    mockUseNodeBeatPreview.mockReturnValue({
      placed: null,
      unplaced: "{{not json{{",
    });
    render(
      <GridSceneCard
        scene={makeScene({ synopsis: null })}
        display={DEFAULT_DISPLAY}
      />,
    );
    // Should fall back gracefully — "空のシーン" if old-format fallback also fails
    // Just assert no crash (render didn't throw)
    expect(document.body).toBeDefined();
  });

  it("shows status label when showStatusLabel=true and status is set", () => {
    render(
      <GridSceneCard
        scene={makeScene({ status: "draft" })}
        display={{ ...DEFAULT_DISPLAY, showStatusLabel: true }}
      />,
    );
    expect(screen.getByText("Draft")).toBeDefined();
  });

  it("hides status label text when showStatusLabel=false (icon-only mode)", () => {
    render(
      <GridSceneCard
        scene={makeScene({ status: "draft" })}
        display={{ ...DEFAULT_DISPLAY, showStatusLabel: false }}
      />,
    );
    // icon-only renders a dot with title="Draft", not visible text
    expect(screen.queryByText("Draft")).toBeNull();
  });

  it("passes disabled=true to useDraggable when editing", () => {
    // Render the card; start editing via double-click on the synopsis area
    const { container } = render(
      <GridSceneCard
        scene={makeScene({ synopsis: "Some text" })}
        display={DEFAULT_DISPLAY}
      />,
    );

    // Find the synopsis text and double-click to enter edit mode
    const synopsisEl = container.querySelector(".cursor-text");
    if (synopsisEl) {
      fireEvent.dblClick(synopsisEl);
    }

    // After editing starts, useDraggable should have been called with disabled=true
    const calls = mockUseDraggable.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.disabled).toBe(true);
  });

  it("drag handle is present when not editing", () => {
    render(<GridSceneCard scene={makeScene()} display={DEFAULT_DISPLAY} />);
    expect(screen.getByLabelText("ドラッグして移動")).toBeDefined();
  });

  it("dimmed=true → 外側 div に opacity-40 クラスが付く", () => {
    const { container } = render(
      <GridSceneCard
        scene={makeScene()}
        display={DEFAULT_DISPLAY}
        dimmed={true}
      />,
    );
    const inner = (container.firstChild as HTMLElement)
      .firstChild as HTMLElement;
    expect(inner.className).toContain("opacity-40");
  });

  it("dimmed=false → opacity-40 クラスが付かない（isDragging=false 時）", () => {
    const { container } = render(
      <GridSceneCard
        scene={makeScene()}
        display={DEFAULT_DISPLAY}
        dimmed={false}
      />,
    );
    const inner = (container.firstChild as HTMLElement)
      .firstChild as HTMLElement;
    expect(inner.className).not.toContain("opacity-40");
  });

  it("charCounts のリアルタイム値をストアから取得して表示する", () => {
    mockTreeStore.mockImplementation((sel) =>
      sel({ pendingRenameId: null, charCounts: { "scene-1": 9999 } }),
    );
    render(
      <GridSceneCard
        scene={makeScene({ charCount: 0 })}
        display={DEFAULT_DISPLAY}
      />,
    );
    expect(screen.getByText("9,999 字")).toBeDefined();
  });

  describe("keyboard & ARIA (a11y)", () => {
    function renderCard(overrides: Partial<TreeNodeData> = {}) {
      render(
        <GridSceneCard
          scene={makeScene(overrides)}
          display={DEFAULT_DISPLAY}
        />,
      );
      return screen.getByRole("group", { name: "Test Scene" });
    }

    it("カードは role=group + aria-label=タイトル + tabIndex=0（nested-interactive 回避）", () => {
      const card = renderCard();
      expect(card.getAttribute("tabindex")).toBe("0");
      expect(card.getAttribute("aria-selected")).toBeNull();
      expect(card.getAttribute("role")).not.toBe("option");
    });

    it("選択状態は aria-current='true' で表現される", () => {
      const card = renderCard();
      expect(card.getAttribute("aria-current")).toBeNull();
      act(() => useGridStore.getState().selectOnly("scene-1"));
      expect(card.getAttribute("aria-current")).toBe("true");
    });

    it("Enter キーで選択 + プレビューが開く", () => {
      const card = renderCard();
      fireEvent.keyDown(card, { key: "Enter" });
      expect(useGridStore.getState().selectedSceneIds.has("scene-1")).toBe(
        true,
      );
      expect(mockOpenPreview).toHaveBeenCalledWith("scene-1");
      expect(mockSetActiveScene).toHaveBeenCalledWith("scene-1");
    });

    it("Space キーでも選択できる", () => {
      const card = renderCard();
      fireEvent.keyDown(card, { key: " " });
      expect(useGridStore.getState().selectedSceneIds.has("scene-1")).toBe(
        true,
      );
    });

    it("Ctrl+Enter は選択をトグルする（プレビューは開かない）", () => {
      const card = renderCard();
      fireEvent.keyDown(card, { key: "Enter", ctrlKey: true });
      expect(useGridStore.getState().selectedSceneIds.has("scene-1")).toBe(
        true,
      );
      fireEvent.keyDown(card, { key: "Enter", ctrlKey: true });
      expect(useGridStore.getState().selectedSceneIds.has("scene-1")).toBe(
        false,
      );
      expect(mockOpenPreview).not.toHaveBeenCalled();
    });

    it("nested interactive 要素（ドラッグハンドル）からの keydown では発火しない", () => {
      renderCard();
      const handle = screen.getByLabelText("ドラッグして移動");
      fireEvent.keyDown(handle, { key: "Enter" });
      expect(useGridStore.getState().selectedSceneIds.size).toBe(0);
      expect(mockOpenPreview).not.toHaveBeenCalled();
    });

    it("カードとドラッグハンドルに focus-visible スタイルがある", () => {
      const card = renderCard();
      expect(card.className).toContain("focus-visible:ring-2");
      const handle = screen.getByLabelText("ドラッグして移動");
      expect(handle.className).toContain("focus-visible:opacity-100");
      expect(handle.className).toContain("group-focus-within:opacity-100");
      expect(handle.className).toContain("focus-visible:ring-1");
    });

    it("エディタで開くボタンはキーボードフォーカス時にも表示される", () => {
      renderCard();
      const btn = screen.getByTestId("grid-card-open-editor-btn");
      expect(btn.className).toContain("group-focus-within:opacity-100");
      expect(btn.className).toContain("focus-visible:opacity-100");
    });
  });
});
