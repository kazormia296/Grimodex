// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { PlotStructureAnalysis } from "./PlotStructureAnalysis";
import { usePlotThreadStore } from "./plotThreadStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useTimelineStore } from "@/features/timeline/timelineStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { PlotThreadRow, PlotThreadLinkRow } from "./api";
import type { PlotPhaseType } from "@/db/schema";
import { toast } from "sonner";

function node(
  id: string,
  title: string,
  status: string | null = null,
): TreeNodeData {
  return {
    id,
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title,
    synopsis: null,
    intent: null,
    sortOrder: "a0",
    status,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}
function thread(id: string, name: string): PlotThreadRow {
  return {
    id,
    projectId: "p1",
    name,
    color: "#f00",
    description: null,
    sortOrder: "a0",
    startNodeId: null,
    endNodeId: null,
    version: 0,
    createdAt: "",
    updatedAt: "",
  };
}
function link(
  threadId: string,
  nodeId: string,
  phaseType: PlotPhaseType,
): PlotThreadLinkRow {
  return {
    id: `${threadId}-${nodeId}-${phaseType}`,
    threadId,
    nodeId,
    phaseType,
    note: null,
    sortOrder: null,
    semanticKey: "",
    version: 0,
    createdAt: "",
    updatedAt: "",
  };
}

describe("PlotStructureAnalysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePlotThreadStore.setState({ threads: [], links: [], branches: [] });
    useTreeStore.setState({ nodes: [], activeSceneId: "" });
    useTimelineStore.setState({
      axisMode: "reading",
      spacingMode: "uniform",
      plotSubwaySort: false,
    });
  });

  it("スレッド0件で空状態を表示", () => {
    render(<PlotStructureAnalysis />);
    expect(screen.getByTestId("plot-structure-empty")).toBeTruthy();
  });

  it("スレッドごとに行（名前＋ステッパー）を描画", () => {
    useTreeStore.setState({
      nodes: [node("s1", "出会い"), node("s2", "対立")],
      activeSceneId: "s2",
    });
    usePlotThreadStore.setState({
      threads: [thread("t1", "復讐")],
      links: [link("t1", "s1", "introduce")],
      branches: [],
    });
    render(<PlotStructureAnalysis />);
    expect(screen.getByText("復讐")).toBeTruthy();
    expect(screen.getByTestId("plot-structure-row-t1")).toBeTruthy();
    expect(screen.getByTestId("phase-stepper-t1")).toBeTruthy();
  });

  it("plotSubwaySort=true で行を重要度 center-out 順に並べる（Scene トラックと一致）", () => {
    useTreeStore.setState({
      nodes: [
        node("s1", "S1"),
        node("s2", "S2"),
        node("s3", "S3"),
        node("s4", "S4"),
        node("s5", "S5"),
        node("s6", "S6"),
      ],
      activeSceneId: "s1",
    });
    usePlotThreadStore.setState({
      threads: [thread("t1", "T1"), thread("t2", "T2"), thread("t3", "T3")],
      links: [
        link("t1", "s1", "introduce"),
        link("t1", "s2", "develop"),
        link("t1", "s3", "turn"), // t1 = 3 シーン（最重要）
        link("t2", "s4", "introduce"), // t2 = 1 シーン
        link("t3", "s5", "introduce"),
        link("t3", "s6", "develop"), // t3 = 2 シーン
      ],
      branches: [],
    });
    useTimelineStore.setState({ plotSubwaySort: true });
    const { container } = render(<PlotStructureAnalysis />);
    const ids = Array.from(
      container.querySelectorAll('[data-testid^="plot-structure-row-"]'),
    ).map((el) => el.getAttribute("data-testid"));
    // 重要度 t1>t3>t2 → rank[t1,t3,t2] → center-out 行[1,2,0] → 視覚順 [t2,t1,t3]
    expect(ids).toEqual([
      "plot-structure-row-t2",
      "plot-structure-row-t1",
      "plot-structure-row-t3",
    ]);
  });

  it("コピーで thread の Markdown を clipboard に書き込む", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    useTreeStore.setState({
      nodes: [node("s1", "出会い")],
      activeSceneId: "s1",
    });
    usePlotThreadStore.setState({
      threads: [thread("t1", "糸")],
      links: [link("t1", "s1", "introduce")],
      branches: [],
    });
    render(<PlotStructureAnalysis />);
    fireEvent.click(screen.getByTestId("plot-structure-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain("## 糸");
  });

  it("clipboard 失敗で toast.error", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("nope"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    usePlotThreadStore.setState({
      threads: [thread("t1", "糸")],
      links: [],
      branches: [],
    });
    render(<PlotStructureAnalysis />);
    fireEvent.click(screen.getByTestId("plot-structure-copy"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});
