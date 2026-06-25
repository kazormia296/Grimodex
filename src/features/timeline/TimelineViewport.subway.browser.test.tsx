/**
 * 実 Chromium で subway レイアウトの幾何 invariant を gate する。
 * happy-dom は SVG の実寸を計算しないため、ここでは
 *  (1) 非線形軸(proportional/weights)でも路線パスに NaN が出ない（xOf に小数列を
 *      渡さない契約 = subwayModel は整数列のみ返し、スタブは px で付与）
 *  (2) 複数トラック駅(白抜き)は単一トラック駅(塗り)より実寸が大きい
 * を実ブラウザで確認する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { TimelineViewport } from "./TimelineViewport";
import { useTimelineStore } from "./timelineStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import type {
  PlotThreadRow,
  PlotThreadLinkRow,
} from "@/features/plot-threads/api";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const scene = (
  id: string,
  title: string,
  storyTimeOrder: string | null,
): TreeNodeData => ({
  id,
  projectId: "p",
  parentId: null,
  nodeType: "scene",
  title,
  synopsis: null,
  intent: null,
  sortOrder: "a0",
  status: "draft",
  storyTimeOrder,
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
  color: string,
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

// proportional 軸で weights が効くよう story_time_order を不均一に置く。
const scenes = [
  scene("s1", "A", "a0"),
  scene("s2", "B", "a4"),
  scene("s3", "C", "a5"),
  scene("s4", "D", "z9"),
];

function seed() {
  usePlotThreadStore.setState({
    threads: [thread("a", "a0", "#34c759"), thread("b", "a1", "#ec4899")],
    links: [
      link("l1", "a", "s1"),
      link("l2", "a", "s2"),
      link("l3", "a", "s3"),
      link("l4", "b", "s2"), // s2 = a,b 共有 → 白抜き
    ],
    branches: [],
    loading: false,
  });
}

describe("TimelineViewport subway – 実ブラウザ幾何 invariant", () => {
  beforeEach(() => {
    useTimelineStore.setState({
      axisMode: "story",
      spacingMode: "proportional",
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
    seed();
  });
  afterEach(cleanup);

  it("proportional(weights) 軸でも路線パスに NaN が出ない", () => {
    const { container } = render(
      <div style={{ width: 900, height: 460, display: "flex" }}>
        <TimelineViewport
          scenes={scenes}
          weights={[0, 0.55, 0.7, 1]}
          unscheduledStartIndex={4}
          onSelectScene={() => {}}
        />
      </div>,
    );
    const tracks = container.querySelectorAll('[data-testid^="subway-track-"]');
    expect(tracks.length).toBeGreaterThan(0);
    for (const tr of tracks) {
      const d = tr.getAttribute("d") ?? "";
      expect(d).not.toContain("NaN");
      expect(d.length).toBeGreaterThan(0);
    }
  });

  it("複数トラック駅は単一トラック駅より実寸が大きい", () => {
    const { getByTestId } = render(
      <div style={{ width: 900, height: 460, display: "flex" }}>
        <TimelineViewport
          scenes={scenes}
          weights={[0, 0.55, 0.7, 1]}
          unscheduledStartIndex={4}
          onSelectScene={() => {}}
        />
      </div>,
    );
    const single = getByTestId("subway-node-s1").getBoundingClientRect();
    const multi = getByTestId("subway-node-s2").getBoundingClientRect();
    expect(multi.width).toBeGreaterThan(single.width);
    // どちらも実際に描画されている（実寸 > 0）。
    expect(single.width).toBeGreaterThan(0);
  });
});
