// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { TimelineViewport } from "./TimelineViewport";
import { useTimelineStore } from "./timelineStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import type {
  PlotThreadRow,
  PlotThreadLinkRow,
} from "@/features/plot-threads/api";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(), isTauri: () => false }));

const scene = (id: string, title: string): TreeNodeData => ({
  id,
  projectId: "p",
  parentId: null,
  nodeType: "scene",
  title,
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
});
const thread = (
  id: string,
  sortOrder: string,
  color: string | null = null,
): PlotThreadRow => ({
  id,
  projectId: "p",
  name: id,
  color,
  description: null,
  sortOrder,
  startNodeId: null,
  endNodeId: null,
  createdAt: "",
  updatedAt: "",
});
const link = (
  id: string,
  threadId: string,
  nodeId: string,
): PlotThreadLinkRow => ({
  id,
  threadId,
  nodeId,
  phaseType: "develop",
  note: null,
  sortOrder: null,
  createdAt: "",
  updatedAt: "",
});

const scenes = [
  scene("s1", "Ryder lets Horner in"),
  scene("s2", "Police report"),
  scene("s3", ""),
];

function reset() {
  useTimelineStore.setState({
    axisMode: "reading",
    spacingMode: "uniform",
    showThreads: true,
    plotLayout: "subway",
    zoom: 1,
    scrollOffset: 0,
    selectedNodeIds: [],
    selectedPlotLinkId: null,
    selectedPlotThreadId: null,
    inspectorOpen: false,
    display: {
      showTitles: true,
      showChapterNumbers: true,
      showPhasePins: false,
    },
  });
  usePlotThreadStore.setState({
    threads: [],
    links: [],
    branches: [],
    loading: false,
  });
}

/** a: s1,s2,s3(3駅・重要) / b: s2(共有) → s2 は multi。 */
function seed() {
  usePlotThreadStore.setState({
    threads: [thread("a", "a0", "#22c55e"), thread("b", "a1", "#ec4899")],
    links: [
      link("la1", "a", "s1"),
      link("la2", "a", "s2"),
      link("la3", "a", "s3"),
      link("lb", "b", "s2"),
    ],
    branches: [],
    loading: false,
  });
}

describe("TimelineViewport – subway レイアウト", () => {
  beforeEach(reset);

  it("subway 本体と各トラックの路線パスを描く", () => {
    seed();
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    expect(getByTestId("plot-subway")).toBeTruthy();
    // a は 3 駅 → 路線パスがある。
    const trackA = getByTestId("subway-track-a");
    expect(trackA.getAttribute("d")).toBeTruthy();
    expect(trackA.getAttribute("stroke")).toBe("#22c55e");
  });

  it("単一トラック駅は塗り(data-multi=false)、複数トラック駅は白抜き(data-multi=true)", () => {
    seed();
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const s1 = getByTestId("subway-node-s1"); // a 単独
    const s2 = getByTestId("subway-node-s2"); // a+b 共有
    expect(s1.getAttribute("data-multi")).toBe("false");
    expect(s2.getAttribute("data-multi")).toBe("true");
    // 単一 = host 色塗り。複数 = 背景塗り(白抜き)＋色リング。
    expect(s1.getAttribute("fill")).toBe("#22c55e");
    expect(s2.getAttribute("fill")).toBe("var(--background, white)");
    // 複数駅は大きい半径。
    expect(Number(s2.getAttribute("r"))).toBeGreaterThan(
      Number(s1.getAttribute("r")),
    );
  });

  it("1 シーン = 1 駅（共有でも駅は1つ）", () => {
    seed();
    const { container } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    expect(
      container.querySelectorAll('[data-testid^="subway-node-"]').length,
    ).toBe(3); // s1,s2,s3
  });

  it("イベント名ラベルにシーンタイトルを出す", () => {
    seed();
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    expect(getByTestId("subway-event-label-s1").textContent).toContain("Ryder");
  });

  it("駅クリックでそのシーンを選択", () => {
    seed();
    const onSelectScene = vi.fn();
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={onSelectScene} />,
    );
    fireEvent.click(getByTestId("subway-node-s2"));
    expect(onSelectScene).toHaveBeenCalledWith("s2");
  });

  it("左ラベルにトラック名・クリックでスレッド選択", () => {
    seed();
    const onSelectThread = vi.fn();
    const { getByTestId } = render(
      <TimelineViewport
        scenes={scenes}
        onSelectScene={vi.fn()}
        onSelectThread={onSelectThread}
      />,
    );
    const label = getByTestId("plot-lane-label-a");
    expect(label.textContent).toContain("a");
    fireEvent.click(label);
    expect(onSelectThread).toHaveBeenCalledWith("a");
  });

  it("行ヒット領域のダブルクリックでマーカー追加", () => {
    seed();
    const addMarker = vi.fn();
    usePlotThreadStore.setState({ addMarker });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    fireEvent.doubleClick(getByTestId("plot-lane-hit-b"));
    expect(addMarker).toHaveBeenCalled();
  });

  it("separated に切替えると subway 本体は出ない（チップが出る）", () => {
    seed();
    useTimelineStore.setState({ plotLayout: "separated" });
    const { queryByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    expect(queryByTestId("plot-subway")).toBeNull();
    expect(queryByTestId("plot-marker-la1")).toBeTruthy();
  });

  it("イベント0のトラックも左ラベルを持つ（路線は無し）", () => {
    usePlotThreadStore.setState({
      threads: [thread("a", "a0"), thread("empty", "a1")],
      links: [link("la1", "a", "s1"), link("la2", "a", "s2")],
      branches: [],
      loading: false,
    });
    const { getByTestId, queryByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    expect(getByTestId("plot-lane-label-empty")).toBeTruthy();
    // 0 駅トラックは路線パス(2点以上)を描かない。
    expect(queryByTestId("subway-track-empty")).toBeNull();
  });
});
