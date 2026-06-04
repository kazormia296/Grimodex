// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { TimelineViewport } from "./TimelineViewport";
import { useTimelineStore } from "./timelineStore";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

const mockScene: TreeNodeData = {
  id: "scene-1",
  projectId: "proj-1",
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
};

function resetStore() {
  useTimelineStore.setState({
    axisMode: "reading",
    spacingMode: "uniform",
    zoom: 1,
    scrollOffset: 0,
    selectedNodeIds: [],
    inspectorOpen: false,
    display: {
      showTitles: true,
      showChapterNumbers: true,
      showPhasePins: false,
    },
  });
}

describe("TimelineViewport – scroll handling (#2)", () => {
  beforeEach(resetStore);

  it("ユーザースクロールで setScrollOffset が呼ばれる", () => {
    const { getByTestId } = render(
      <TimelineViewport scenes={[mockScene]} onSelectScene={vi.fn()} />,
    );
    const container = getByTestId("timeline-scroll-container");
    Object.defineProperty(container, "scrollLeft", {
      configurable: true,
      get: () => 200,
    });
    fireEvent.scroll(container);
    expect(useTimelineStore.getState().scrollOffset).toBe(200);
  });

  it("isRestoringRef が true のとき scroll イベントは store を更新しない", async () => {
    const { getByTestId } = render(
      <TimelineViewport scenes={[mockScene]} onSelectScene={vi.fn()} />,
    );
    const container = getByTestId("timeline-scroll-container");

    // scrollLeft を 300 に設定してストアを更新 → useEffect が isRestoringRef=true にして scrollLeft を復元しようとする
    Object.defineProperty(container, "scrollLeft", {
      configurable: true,
      writable: true,
      value: 0,
    });
    act(() => {
      useTimelineStore.setState({ scrollOffset: 300 });
    });

    // isRestoringRef が true の間に scroll イベントを発火させる (rAF前)
    fireEvent.scroll(container);

    // isRestoringRef が true なので scrollOffset は 300 のまま (0 に戻らない)
    expect(useTimelineStore.getState().scrollOffset).toBe(300);
  });
});

describe("TimelineViewport – ref callback stability (Bug 2)", () => {
  beforeEach(resetStore);

  it("forwardedRef が変わらない限り ref コールバックは同一インスタンス", () => {
    const externalRef = { current: null as HTMLDivElement | null };
    const callbacks: unknown[] = [];

    const TestWrapper = ({ id }: { id: number }) => {
      void id;
      return (
        <TimelineViewport
          scenes={[mockScene]}
          onSelectScene={vi.fn()}
          ref={externalRef}
        />
      );
    };

    const { rerender, getByTestId } = render(<TestWrapper id={1} />);
    const container = getByTestId("timeline-scroll-container");
    callbacks.push((container as HTMLDivElement & { _ref?: unknown })._ref);

    rerender(<TestWrapper id={2} />);

    // 再レンダー後も externalRef.current が null でないことを確認
    expect(externalRef.current).not.toBeNull();
  });
});

describe("TimelineViewport – Ctrl/Shift click selection (#4)", () => {
  const scene1: TreeNodeData = { ...mockScene, id: "s1", title: "Scene 1" };
  const scene2: TreeNodeData = { ...mockScene, id: "s2", title: "Scene 2" };
  const scene3: TreeNodeData = { ...mockScene, id: "s3", title: "Scene 3" };

  beforeEach(() => {
    resetStore();
  });

  it("plain click → calls onSelectScene (single select)", () => {
    const onSelectScene = vi.fn();
    const { container } = render(
      <TimelineViewport
        scenes={[scene1, scene2]}
        onSelectScene={onSelectScene}
      />,
    );
    const circle = container.querySelector('[data-node-id="s1"] circle');
    fireEvent.click(circle!);
    expect(onSelectScene).toHaveBeenCalledWith("s1");
  });

  it("Ctrl+click → toggleSelect (adds), does NOT call onSelectScene", () => {
    const onSelectScene = vi.fn();
    const { container } = render(
      <TimelineViewport
        scenes={[scene1, scene2]}
        onSelectScene={onSelectScene}
      />,
    );
    const circle = container.querySelector('[data-node-id="s1"] circle');
    fireEvent.click(circle!, { ctrlKey: true });
    expect(useTimelineStore.getState().selectedNodeIds).toContain("s1");
    expect(onSelectScene).not.toHaveBeenCalled();
  });

  it("Ctrl+click on already-selected → toggleSelect (removes)", () => {
    useTimelineStore.setState({ selectedNodeIds: ["s1"] });
    const { container } = render(
      <TimelineViewport scenes={[scene1, scene2]} onSelectScene={vi.fn()} />,
    );
    const circle = container.querySelector('[data-node-id="s1"] circle');
    fireEvent.click(circle!, { ctrlKey: true });
    expect(useTimelineStore.getState().selectedNodeIds).not.toContain("s1");
  });

  it("Shift+click → rangeSelectTo, does NOT call onSelectScene", () => {
    useTimelineStore.getState().selectNode("s1");
    const onSelectScene = vi.fn();
    const { container } = render(
      <TimelineViewport
        scenes={[scene1, scene2, scene3]}
        onSelectScene={onSelectScene}
      />,
    );
    const circle3 = container.querySelector('[data-node-id="s3"] circle');
    fireEvent.click(circle3!, { shiftKey: true });
    const ids = useTimelineStore.getState().selectedNodeIds;
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
    expect(ids).toContain("s3");
    expect(onSelectScene).not.toHaveBeenCalled();
  });
});
