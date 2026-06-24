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
        x={10}
        y={10}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(getByText("マーカーを削除"));
    expect(deleteMarker).toHaveBeenCalledWith("l1");
  });
});
