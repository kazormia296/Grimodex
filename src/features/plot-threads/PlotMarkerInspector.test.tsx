// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { PlotMarkerInspector } from "./PlotMarkerInspector";
import { usePlotThreadStore } from "./plotThreadStore";
import { useTimelineStore } from "@/features/timeline/timelineStore";
import type { PlotThreadRow, PlotThreadLinkRow } from "./api";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(), isTauri: () => false }));

const thread: PlotThreadRow = {
  id: "t1",
  projectId: "p1",
  name: "復讐の糸",
  color: null,
  description: null,
  sortOrder: "a0",
  createdAt: "",
  updatedAt: "",
};
const link: PlotThreadLinkRow = {
  id: "l1",
  threadId: "t1",
  nodeId: "s1",
  phaseType: "introduce",
  note: null,
  sortOrder: null,
  createdAt: "",
  updatedAt: "",
};

describe("PlotMarkerInspector", () => {
  beforeEach(() => {
    usePlotThreadStore.setState({
      threads: [thread],
      links: [link],
      loading: false,
    });
    useTimelineStore.setState({
      selectedPlotLinkId: "l1",
      selectedPlotThreadId: null,
    });
  });

  it("選択中マーカーの phase 変更で updateMarker を呼ぶ", () => {
    const updateMarker = vi.fn();
    usePlotThreadStore.setState({ updateMarker });
    const { container } = render(<PlotMarkerInspector onClose={vi.fn()} />);
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "climax" } });
    expect(updateMarker).toHaveBeenCalledWith("l1", { phaseType: "climax" });
  });

  it("削除ボタンで deleteMarker を呼び選択を解除する", () => {
    const deleteMarker = vi.fn();
    usePlotThreadStore.setState({ deleteMarker });
    const { getByText } = render(<PlotMarkerInspector onClose={vi.fn()} />);
    fireEvent.click(getByText("マーカーを削除"));
    expect(deleteMarker).toHaveBeenCalledWith("l1");
    expect(useTimelineStore.getState().selectedPlotLinkId).toBeNull();
  });

  it("何も選択していなければプレースホルダーを出す", () => {
    useTimelineStore.setState({
      selectedPlotLinkId: null,
      selectedPlotThreadId: null,
    });
    const { getByText } = render(<PlotMarkerInspector onClose={vi.fn()} />);
    expect(getByText("スレッドかマーカーを選択してください")).toBeTruthy();
  });

  it("レーン見出し選択（マーカー無し）でスレッドの改名・削除ができる", () => {
    const renameThread = vi.fn();
    const deleteThread = vi.fn();
    usePlotThreadStore.setState({ renameThread, deleteThread });
    useTimelineStore.setState({
      selectedPlotLinkId: null,
      selectedPlotThreadId: "t1",
    });
    const { getByText, container } = render(
      <PlotMarkerInspector onClose={vi.fn()} />,
    );
    // 名前入力 onBlur で renameThread
    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "新章" } });
    fireEvent.blur(input);
    expect(renameThread).toHaveBeenCalledWith("t1", "新章");
    // 削除
    fireEvent.click(getByText("スレッドを削除"));
    expect(deleteThread).toHaveBeenCalledWith("t1");
    expect(useTimelineStore.getState().selectedPlotThreadId).toBeNull();
  });
});
