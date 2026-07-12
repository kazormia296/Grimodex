// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGridDragController } from "./useGridDragController";
import type { TreeNodeData } from "@/features/tree/treeStore";

const scene = (id: string, sortOrder: string): TreeNodeData => ({
  id,
  projectId: "project-1",
  nodeType: "scene",
  parentId: null,
  title: id,
  sortOrder,
  synopsis: null,
  intent: null,
  status: null,
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  chronicleStartTime: null,
  chronicleStartGranularity: "none",
  chronicleEndTime: null,
  chronicleEndGranularity: "none",
  chronicleStartMinute: null,
  chronicleEndMinute: null,
  charCount: 0,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});

describe("useGridDragController", () => {
  it("owns active drag state and clears it on cancel", () => {
    const nodes = [scene("s1", "a0")];
    const { result } = renderHook(() =>
      useGridDragController({
        nodes,
        orderedScenes: [{ id: "s1", parentId: null }],
        flatOrder: ["s1"],
        containerId: null,
        selectedSceneIds: new Set(["s1"]),
        moveNode: vi.fn().mockResolvedValue(undefined),
      }),
    );

    act(() =>
      result.current.handleDragStart({
        active: { id: "scene-s1" },
      } as never),
    );
    expect(result.current.activeId).toBe("scene-s1");
    expect(result.current.activeDragNode?.id).toBe("s1");

    act(() => result.current.handleDragCancel());
    expect(result.current.activeId).toBeNull();
    expect(result.current.dropIndicator).toBeNull();
  });
});
