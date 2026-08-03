// @vitest-environment happy-dom
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useLensStore } from "@/features/post-effect/lensStore";
import type { SceneLensRecord } from "@/features/post-effect/types";
import { LensDot } from "./LensDot";
import { useTreeStore, type TreeNodeData } from "./treeStore";

function makeNode(id: string, updatedAt: string): TreeNodeData {
  return {
    id,
    projectId: "project-1",
    parentId: null,
    nodeType: "scene",
    title: id,
    synopsis: null,
    intent: null,
    sortOrder: id,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt,
  };
}

function makeLens(): SceneLensRecord {
  return {
    id: "lens-1",
    projectId: "project-1",
    runId: "run-1",
    targetId: "scene-1",
    lensType: "plot_structure",
    metrics: {},
    finding: null,
    severity: "warning",
    createdAt: "2026-07-29T00:00:01.000Z",
    runCompletedAt: "2026-07-29T00:00:01.000Z",
  };
}

describe("LensDot tree updatedAt subscription", () => {
  beforeEach(() => {
    useTreeStore.setState({
      nodes: [
        makeNode("scene-1", "2026-07-29T00:00:00.000Z"),
        makeNode("scene-2", "2026-07-29T00:00:00.000Z"),
      ],
    });
    useLensStore.setState({
      showLensOverlay: true,
      bySceneId: new Map([["scene-1", [makeLens()]]]),
    });
  });

  it("対象sceneのtimestampだけを追跡してstale表示を更新する", () => {
    const { container } = render(<LensDot sceneId="scene-1" />);
    const dot = container.querySelector("span");
    expect(dot?.classList.contains("opacity-30")).toBe(false);

    act(() => {
      useTreeStore.setState((state) => ({
        nodes: state.nodes.map((node) =>
          node.id === "scene-2"
            ? { ...node, updatedAt: "2026-07-29T00:00:02.000Z" }
            : node,
        ),
      }));
    });
    expect(dot?.classList.contains("opacity-30")).toBe(false);

    act(() => {
      useTreeStore.setState((state) => ({
        nodes: state.nodes.map((node) =>
          node.id === "scene-1"
            ? { ...node, updatedAt: "2026-07-29T00:00:02.000Z" }
            : node,
        ),
      }));
    });
    expect(dot?.classList.contains("opacity-30")).toBe(true);
  });
});
