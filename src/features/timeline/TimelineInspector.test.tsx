// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { TimelineInspector } from "./TimelineInspector";
import { useTimelineStore } from "./timelineStore";
import type { TreeNodeData } from "@/features/tree/treeStore";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: vi.fn((sel: (s: unknown) => unknown) =>
    sel({ phasesByEntry: {} }),
  ),
}));

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: vi.fn((sel: (s: unknown) => unknown) => sel({ entries: [] })),
}));

const mockNode: TreeNodeData = {
  id: "scene-1",
  projectId: "proj-1",
  parentId: null,
  nodeType: "scene",
  title: "Scene 1",
  synopsis: null,
  sortOrder: "a0",
  status: "draft",
  storyTimeOrder: "a0",
  storyTimeLabel: "Day 1",
  povCharacterId: null,
  locationId: null,
  createdAt: "2024-01-01T00:00:00Z",

  charCount: 0,
  updatedAt: "2024-01-01T00:00:00Z",
};

function resetStore() {
  useTimelineStore.setState({
    axisMode: "story",
    spacingMode: "proportional",
    zoom: 1,
    scrollOffset: 0,
    selectedNodeIds: [],
    inspectorOpen: true,
    pendingEditNodeId: null,
    display: {
      showTitles: true,
      showChapterNumbers: true,
      showPhasePins: false,
    },
  });
}

describe("TimelineInspector – pendingEditNodeId focus wiring", () => {
  beforeEach(resetStore);

  it("pendingEditNodeId が一致したとき label input にフォーカスされ pendingEditNodeId がクリアされる", () => {
    const { getByRole } = render(
      <TimelineInspector
        node={mockNode}
        onClose={vi.fn()}
        onUpdateStoryTimeLabel={vi.fn()}
      />,
    );
    const input = getByRole("textbox");
    act(() => {
      useTimelineStore.getState().setPendingEditNodeId("scene-1");
    });
    expect(document.activeElement).toBe(input);
    expect(useTimelineStore.getState().pendingEditNodeId).toBeNull();
  });

  it("pendingEditNodeId が別のノード id の場合はフォーカスしない", () => {
    const { getByRole } = render(
      <TimelineInspector
        node={mockNode}
        onClose={vi.fn()}
        onUpdateStoryTimeLabel={vi.fn()}
      />,
    );
    const input = getByRole("textbox");
    act(() => {
      useTimelineStore.getState().setPendingEditNodeId("other-id");
    });
    expect(document.activeElement).not.toBe(input);
    expect(useTimelineStore.getState().pendingEditNodeId).toBe("other-id");
  });
});
