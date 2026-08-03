// @vitest-environment happy-dom
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useTreeStore, type TreeNodeData } from "./treeStore";
import { useScenesPanelNodes } from "./useScenesPanelNodes";

function makeNode(overrides: Partial<TreeNodeData> = {}): TreeNodeData {
  return {
    id: "scene-1",
    projectId: "project-1",
    parentId: null,
    nodeType: "scene",
    title: "Scene 1",
    synopsis: null,
    intent: null,
    sortOrder: "a0",
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

describe("useScenesPanelNodes", () => {
  beforeEach(() => {
    useTreeStore.setState({ nodes: [makeNode()] });
  });

  it("updatedAtだけの更新ではpanelを再renderせず、表示属性の更新では最新snapshotを返す", () => {
    let renderCount = 0;
    let selectedNodes: TreeNodeData[] | null = null;

    function Probe() {
      selectedNodes = useScenesPanelNodes();
      renderCount += 1;
      return null;
    }

    render(<Probe />);
    const initialRenderCount = renderCount;
    const initialSelection = selectedNodes;

    act(() => {
      useTreeStore.setState((state) => ({
        nodes: state.nodes.map((node) => ({
          ...node,
          updatedAt: "2026-07-29T00:00:01.000Z",
        })),
      }));
    });

    expect(renderCount).toBe(initialRenderCount);
    expect(selectedNodes).toBe(initialSelection);

    act(() => {
      useTreeStore.setState((state) => ({
        nodes: state.nodes.map((node) => ({
          ...node,
          title: "Scene 1 updated",
          updatedAt: "2026-07-29T00:00:02.000Z",
        })),
      }));
    });

    expect(renderCount).toBe(initialRenderCount + 1);
    expect(selectedNodes).toBe(useTreeStore.getState().nodes);
    expect(selectedNodes?.[0]).toMatchObject({
      title: "Scene 1 updated",
      updatedAt: "2026-07-29T00:00:02.000Z",
    });
  });
});
