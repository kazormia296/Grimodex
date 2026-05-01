// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { GridDisplaySettings } from "../gridStore";

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
  useTabStore: { getState: vi.fn(() => ({ openPinned: vi.fn() })) },
}));
vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: { getState: vi.fn(() => ({ showPanel: vi.fn() })) },
}));
vi.mock("@/features/codex/sceneCodexPinsStore", () => ({
  useSceneCodexPinsStore: vi.fn(
    (sel: (s: { pinsByScene: Record<string, string[]> }) => unknown) =>
      sel({ pinsByScene: {} }),
  ),
}));
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: vi.fn((sel: (s: { entries: unknown[] }) => unknown) =>
    sel({ entries: [] }),
  ),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: Object.assign(
    vi.fn((sel: (s: { pendingRenameId: string | null }) => unknown) =>
      sel({ pendingRenameId: null }),
    ),
    {
      getState: vi.fn(() => ({
        pendingRenameId: null,
        setPendingRenameId: vi.fn(),
      })),
    },
  ),
}));

import { useDraggable } from "@dnd-kit/core";

const mockUseDraggable = vi.mocked(useDraggable);

// --- component under test (imported after mocks) ---
import { GridSceneCard } from "../GridSceneCard";

const DEFAULT_DISPLAY: GridDisplaySettings = {
  showSynopsis: true,
  showBeats: true,
  showCodex: true,
  showLabel: true,
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
    unplacedBeatPreview: null,
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
        scene={makeScene({ synopsis: null, unplacedBeatPreview: null })}
        display={{ ...DEFAULT_DISPLAY, showSynopsis: false, showBeats: false }}
      />,
    );
    expect(screen.getByText("空のシーン")).toBeDefined();
  });

  it("shows beat bullets when synopsis empty but beats present", () => {
    const preview = JSON.stringify(["Beat one", "Beat two"]);
    render(
      <GridSceneCard
        scene={makeScene({ synopsis: null, unplacedBeatPreview: preview })}
        display={DEFAULT_DISPLAY}
      />,
    );
    expect(screen.getByText("Beat one")).toBeDefined();
    expect(screen.getByText("Beat two")).toBeDefined();
  });

  it("renders without crashing when unplacedBeatPreview is malformed", () => {
    render(
      <GridSceneCard
        scene={makeScene({
          synopsis: null,
          unplacedBeatPreview: "{{not json{{",
        })}
        display={DEFAULT_DISPLAY}
      />,
    );
    // Should fall back gracefully — "空のシーン" if old-format fallback also fails
    // Just assert no crash (render didn't throw)
    expect(document.body).toBeDefined();
  });

  it("shows status label when showLabel=true and status is set", () => {
    render(
      <GridSceneCard
        scene={makeScene({ status: "draft" })}
        display={{ ...DEFAULT_DISPLAY, showLabel: true }}
      />,
    );
    expect(screen.getByText("draft")).toBeDefined();
  });

  it("hides status label when showLabel=false", () => {
    render(
      <GridSceneCard
        scene={makeScene({ status: "draft" })}
        display={{ ...DEFAULT_DISPLAY, showLabel: false }}
      />,
    );
    expect(screen.queryByText("draft")).toBeNull();
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
});
