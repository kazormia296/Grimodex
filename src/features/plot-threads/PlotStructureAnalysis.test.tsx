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
    createdAt: "",
    updatedAt: "",
  };
}

describe("PlotStructureAnalysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePlotThreadStore.setState({ threads: [], links: [], branches: [] });
    useTreeStore.setState({ nodes: [], activeSceneId: "" });
    useTimelineStore.setState({ axisMode: "reading", spacingMode: "uniform" });
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
