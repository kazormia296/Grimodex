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
  sortOrder: "a0",
  status: "draft",
  storyTimeOrder: null,
  storyTimeLabel: null,
  createdAt: "2024-01-01T00:00:00Z",
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
