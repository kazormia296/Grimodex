// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TimelineContextMenu } from "./TimelineContextMenu";
import type { TreeNodeData } from "@/features/tree/treeStore";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

const mockSetStatus = vi.fn();
const mockDeleteNode = vi.fn();
const mockUpdateStoryTime = vi.fn();
const mockRevealInTree = vi.fn();
const mockOpenPinned = vi.fn();
const mockOpenInSecondaryGroup = vi.fn();

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: vi.fn((sel: (s: unknown) => unknown) =>
    sel({
      setStatus: mockSetStatus,
      deleteNode: mockDeleteNode,
      updateStoryTime: mockUpdateStoryTime,
      revealInTree: mockRevealInTree,
      setActiveScene: vi.fn(),
    }),
  ),
}));

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

vi.mock("@/features/tree/StatusDot", () => ({
  StatusDot: ({ status }: { status: string }) => (
    <span data-testid={`status-dot-${status}`} />
  ),
}));

const scene: TreeNodeData = {
  id: "scene-1",
  projectId: "proj-1",
  parentId: null,
  nodeType: "scene",
  title: "テストシーン",
  synopsis: null,
  sortOrder: "a0",
  status: "draft",
  storyTimeOrder: "a0",
  storyTimeLabel: "Day 1",
  povCharacterId: null,
  locationId: null,
  createdAt: "2024-01-01T00:00:00Z",

  charCount: 0,
  unplacedBeatPreview: null,
  placedBeatPreview: null,
  updatedAt: "2024-01-01T00:00:00Z",
};

describe("TimelineContextMenu", () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("正しく描画される", () => {
    render(
      <TimelineContextMenu
        node={scene}
        x={100}
        y={100}
        onClose={onClose}
        axisMode="story"
      />,
    );
    expect(screen.getByText(/Editor/i)).toBeInTheDocument();
  });

  it("「Open in Editor」クリックで openPinned が呼ばれる", () => {
    render(
      <TimelineContextMenu
        node={scene}
        x={100}
        y={100}
        onClose={onClose}
        axisMode="story"
      />,
    );
    fireEvent.click(screen.getByText(/Editor で開く|Open in Editor/i));
    expect(mockOpenPinned).toHaveBeenCalledWith("scene-1");
    expect(onClose).toHaveBeenCalled();
  });

  it("「Show in Scenes」クリックで revealInTree が呼ばれる", () => {
    render(
      <TimelineContextMenu
        node={scene}
        x={100}
        y={100}
        onClose={onClose}
        axisMode="story"
      />,
    );
    fireEvent.click(screen.getByText(/Scenes.*表示|Show in Scenes/i));
    expect(mockRevealInTree).toHaveBeenCalledWith("scene-1");
    expect(onClose).toHaveBeenCalled();
  });

  it("「Clear story-time」クリックで updateStoryTime(null) が呼ばれる (story軸)", () => {
    render(
      <TimelineContextMenu
        node={scene}
        x={100}
        y={100}
        onClose={onClose}
        axisMode="story"
      />,
    );
    fireEvent.click(screen.getByText(/Clear story-time/i));
    expect(mockUpdateStoryTime).toHaveBeenCalledWith("scene-1", null);
    expect(onClose).toHaveBeenCalled();
  });

  it("story軸以外では Clear story-time ボタンが表示されない", () => {
    render(
      <TimelineContextMenu
        node={scene}
        x={100}
        y={100}
        onClose={onClose}
        axisMode="reading"
      />,
    );
    expect(screen.queryByText(/Clear story-time/i)).not.toBeInTheDocument();
  });

  it("Escape キーで onClose が呼ばれる", () => {
    render(
      <TimelineContextMenu
        node={scene}
        x={100}
        y={100}
        onClose={onClose}
        axisMode="story"
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("status ボタンクリックで setStatus が呼ばれる", () => {
    render(
      <TimelineContextMenu
        node={scene}
        x={100}
        y={100}
        onClose={onClose}
        axisMode="story"
      />,
    );
    fireEvent.click(screen.getByText("Complete"));
    expect(mockSetStatus).toHaveBeenCalledWith("scene-1", "complete");
    expect(onClose).toHaveBeenCalled();
  });

  it("「削除」クリックで deleteNode が呼ばれる", () => {
    render(
      <TimelineContextMenu
        node={scene}
        x={100}
        y={100}
        onClose={onClose}
        axisMode="story"
      />,
    );
    fireEvent.click(screen.getByText(/削除|Delete/i));
    expect(mockDeleteNode).toHaveBeenCalledWith("scene-1");
    expect(onClose).toHaveBeenCalled();
  });
});
