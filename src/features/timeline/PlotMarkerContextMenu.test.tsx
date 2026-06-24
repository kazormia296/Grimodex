// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { PlotMarkerContextMenu } from "./PlotMarkerContextMenu";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { useTimelineStore } from "./timelineStore";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(), isTauri: () => false }));

describe("PlotMarkerContextMenu", () => {
  beforeEach(() => {
    useTimelineStore.setState({
      selectedPlotLinkId: null,
      inspectorOpen: false,
    });
  });

  it("段階クリックで updateMarker(phaseType) を呼ぶ", () => {
    const updateMarker = vi.fn();
    usePlotThreadStore.setState({ updateMarker });
    const { getByText } = render(
      <PlotMarkerContextMenu
        linkId="l1"
        phaseType="introduce"
        nodeId="n1"
        threadId="t1"
        x={10}
        y={10}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(getByText("クライマックス"));
    expect(updateMarker).toHaveBeenCalledWith("l1", { phaseType: "climax" });
  });

  it("「メモを編集」でマーカーを選択しインスペクタを開く", () => {
    const { getByText } = render(
      <PlotMarkerContextMenu
        linkId="l1"
        phaseType="introduce"
        nodeId="n1"
        threadId="t1"
        x={10}
        y={10}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(getByText("メモを編集"));
    expect(useTimelineStore.getState().selectedPlotLinkId).toBe("l1");
    expect(useTimelineStore.getState().inspectorOpen).toBe(true);
  });

  it("「マーカーを削除」で deleteMarker を呼ぶ", () => {
    const deleteMarker = vi.fn();
    usePlotThreadStore.setState({ deleteMarker });
    const { getByText } = render(
      <PlotMarkerContextMenu
        linkId="l1"
        phaseType="introduce"
        nodeId="n1"
        threadId="t1"
        x={10}
        y={10}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(getByText("マーカーを削除"));
    expect(deleteMarker).toHaveBeenCalledWith("l1");
  });

  it("このシーン/スレッドに掛かる分岐エッジの削除ボタンが出て deleteBranch を呼ぶ", () => {
    const deleteBranch = vi.fn();
    const now = "2026-06-24T00:00:00.000Z";
    usePlotThreadStore.setState({
      deleteBranch,
      threads: [
        {
          id: "t1",
          projectId: "p",
          name: "復讐",
          color: null,
          description: null,
          sortOrder: "a0",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "t2",
          projectId: "p",
          name: "恋愛",
          color: null,
          description: null,
          sortOrder: "a1",
          createdAt: now,
          updatedAt: now,
        },
      ],
      branches: [
        {
          id: "b1",
          projectId: "p",
          fromThreadId: "t1",
          toThreadId: "t2",
          atNodeId: "n1",
          kind: "branch",
          createdAt: now,
          updatedAt: now,
        },
        // 別シーンのエッジは出さない
        {
          id: "b2",
          projectId: "p",
          fromThreadId: "t1",
          toThreadId: "t2",
          atNodeId: "n-other",
          kind: "merge",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const onClose = vi.fn();
    const { getByText, queryByText } = render(
      <PlotMarkerContextMenu
        linkId="l1"
        phaseType="introduce"
        nodeId="n1"
        threadId="t1"
        x={10}
        y={10}
        onClose={onClose}
      />,
    );
    // n1 のエッジ(b1)だけが候補。別シーン n-other の b2 は出ない。
    expect(queryByText("復讐 → 恋愛 の分岐を削除")).not.toBeNull();
    fireEvent.click(getByText("復讐 → 恋愛 の分岐を削除"));
    expect(deleteBranch).toHaveBeenCalledWith("b1");
    expect(onClose).toHaveBeenCalled();
  });
});
