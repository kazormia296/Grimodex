// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("./writingStatsQuery", () => ({
  loadWritingStatsData: vi.fn(),
}));

import { WritingStatsPanel } from "./WritingStatsPanel";
import { loadWritingStatsData } from "./writingStatsQuery";
import { useTreeStore } from "@/features/tree/treeStore";

function setupTree(projectId: string) {
  useTreeStore.setState({
    projectId,
    // パネルが読むのは id / nodeType のみ。最小ノードを cast で渡す。
    nodes: [
      { id: "s1", nodeType: "scene" },
      { id: "f1", nodeType: "folder" },
    ] as never,
  });
}

describe("WritingStatsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("執筆記録があるとヒートマップと内訳を描画する", async () => {
    setupTree("p1");
    const now = Date.now();
    vi.mocked(loadWritingStatsData).mockResolvedValue({
      events: [
        { timestamp: now, chars: 120 },
        { timestamp: now - 86_400_000, chars: 80 },
      ],
      attribution: { human: 150, ai: 40, unknown: 10, total: 200 },
      usage: null,
    });

    render(<WritingStatsPanel isActive />);

    await waitFor(() =>
      expect(screen.getByTestId("writing-stats-heatmap")).toBeInTheDocument(),
    );
    // 帰属内訳バー（BreakdownBar の human セグメント）が出る
    expect(
      document.querySelector('[data-segment="human"]'),
    ).toBeInTheDocument();
    // クエリは現プロジェクト ID と scene id のみで呼ばれる
    expect(loadWritingStatsData).toHaveBeenCalledWith(
      "p1",
      ["s1"],
      expect.any(Number),
    );
  });

  it("記録が無いと noData を表示しヒートマップは出ない", async () => {
    setupTree("p1");
    vi.mocked(loadWritingStatsData).mockResolvedValue({
      events: [],
      attribution: { human: 0, ai: 0, unknown: 0, total: 0 },
      usage: null,
    });

    render(<WritingStatsPanel isActive />);

    await waitFor(() => expect(loadWritingStatsData).toHaveBeenCalled());
    expect(screen.getByTestId("writing-stats-panel")).toBeInTheDocument();
    expect(
      screen.queryByTestId("writing-stats-heatmap"),
    ).not.toBeInTheDocument();
  });

  it("hidden（isActive=false）のときはクエリを実行しない（keepalive）", () => {
    setupTree("p1");
    vi.mocked(loadWritingStatsData).mockResolvedValue({
      events: [],
      attribution: { human: 0, ai: 0, unknown: 0, total: 0 },
      usage: null,
    });

    render(<WritingStatsPanel isActive={false} />);

    expect(loadWritingStatsData).not.toHaveBeenCalled();
  });
});
