// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, within } from "@testing-library/react";
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
  startNodeId: null,
  endNodeId: null,
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
      branches: [],
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
    const { getByLabelText } = render(
      <PlotMarkerInspector width={224} onClose={vi.fn()} />,
    );
    const select = getByLabelText("段階") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "climax" } });
    expect(updateMarker).toHaveBeenCalledWith("l1", { phaseType: "climax" });
  });

  it("削除ボタンで deleteMarker を呼び選択を解除する", () => {
    const deleteMarker = vi.fn();
    usePlotThreadStore.setState({ deleteMarker });
    const { getByText } = render(
      <PlotMarkerInspector width={224} onClose={vi.fn()} />,
    );
    fireEvent.click(getByText("マーカーを削除"));
    expect(deleteMarker).toHaveBeenCalledWith("l1");
    expect(useTimelineStore.getState().selectedPlotLinkId).toBeNull();
  });

  it("色スウォッチクリックで setThreadColor が Codex パレット色で呼ばれる", () => {
    const setThreadColor = vi.fn();
    usePlotThreadStore.setState({ setThreadColor });
    // レーン見出し選択（マーカー無し）でもスレッド編集部＝色ピッカーが出る。
    useTimelineStore.setState({
      selectedPlotLinkId: null,
      selectedPlotThreadId: "t1",
    });
    const { getByRole } = render(
      <PlotMarkerInspector width={224} onClose={vi.fn()} />,
    );
    const group = getByRole("group", { name: "色" });
    const buttons = within(group).getAllByRole("button");
    // 10 パレット + クリア = 11
    expect(buttons).toHaveLength(11);
    // simple(既定) light スロット0 = Blue #2045AA
    fireEvent.click(buttons[0]);
    expect(setThreadColor).toHaveBeenCalledWith("t1", "#2045AA");
    // 末尾はクリア（null）
    fireEvent.click(buttons[10]);
    expect(setThreadColor).toHaveBeenCalledWith("t1", null);
  });

  it("マーカー選択時、別スレッドへの分岐を追加し、マーカーを対象スレッドへ移す", () => {
    const addBranch = vi.fn();
    const updateMarker = vi.fn();
    const thread2: PlotThreadRow = { ...thread, id: "t2", name: "恋愛の糸" };
    usePlotThreadStore.setState({
      threads: [thread, thread2],
      addBranch,
      updateMarker,
    });
    useTimelineStore.setState({
      selectedPlotLinkId: "l1", // thread t1 / scene s1
      selectedPlotThreadId: null,
    });
    const { getByTestId, getByText } = render(
      <PlotMarkerInspector width={224} onClose={vi.fn()} />,
    );
    // 分岐エディタが出る
    expect(getByTestId("plot-branch-editor")).toBeTruthy();
    // 「追加」で addBranch が from=t1, to=t2, at=s1, kind=branch で呼ばれる
    fireEvent.click(getByText("追加"));
    expect(addBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        fromThreadId: "t1",
        toThreadId: "t2",
        atNodeId: "s1",
        kind: "branch",
      }),
    );
    // 統一モデル: 選択マーカー l1 は移動先 = 対象(to=t2)スレッドへ移る（D&D と同じ終端状態）。
    expect(updateMarker).toHaveBeenCalledWith("l1", {
      threadId: "t2",
      nodeId: "s1",
    });
  });

  it("branch/merge 起点マーカーの削除は確認ダイアログを挟む", () => {
    const deleteMarker = vi.fn();
    const thread2: PlotThreadRow = { ...thread, id: "t2", name: "恋愛の糸" };
    usePlotThreadStore.setState({
      threads: [thread, thread2],
      links: [link], // l1 = t1 / s1
      branches: [
        {
          id: "mg1",
          projectId: "p1",
          fromThreadId: "t2",
          toThreadId: "t1", // l1(t1@s1) が merge の流入先＝アンカー
          atNodeId: "s1",
          kind: "merge",
          createdAt: "",
          updatedAt: "",
        },
      ],
      deleteMarker,
    });
    useTimelineStore.setState({
      selectedPlotLinkId: "l1",
      selectedPlotThreadId: null,
    });
    const { getByText } = render(
      <PlotMarkerInspector width={224} onClose={vi.fn()} />,
    );
    fireEvent.click(getByText("マーカーを削除"));
    // 即削除されず確認ダイアログ。「削除する」で実削除。
    expect(deleteMarker).not.toHaveBeenCalled();
    fireEvent.click(getByText("削除する"));
    expect(deleteMarker).toHaveBeenCalledWith("l1");
  });

  it("非アンカーのマーカー削除は確認なしで即実行", () => {
    const deleteMarker = vi.fn();
    usePlotThreadStore.setState({
      threads: [thread],
      links: [link],
      branches: [],
      deleteMarker,
    });
    useTimelineStore.setState({
      selectedPlotLinkId: "l1",
      selectedPlotThreadId: null,
    });
    const { getByText, queryByText } = render(
      <PlotMarkerInspector width={224} onClose={vi.fn()} />,
    );
    fireEvent.click(getByText("マーカーを削除"));
    expect(deleteMarker).toHaveBeenCalledWith("l1");
    expect(queryByText("削除する")).toBeNull();
  });

  it("何も選択していなければプレースホルダーを出す", () => {
    useTimelineStore.setState({
      selectedPlotLinkId: null,
      selectedPlotThreadId: null,
    });
    const { getByText } = render(
      <PlotMarkerInspector width={224} onClose={vi.fn()} />,
    );
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
      <PlotMarkerInspector width={224} onClose={vi.fn()} />,
    );
    // 名前入力 onBlur で renameThread
    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "新章" } });
    fireEvent.blur(input);
    expect(renameThread).toHaveBeenCalledWith("t1", "新章");
    // 削除: t1 はマーカー(l1)を持つので確認ダイアログ。「削除する」で実削除。
    fireEvent.click(getByText("スレッドを削除"));
    expect(deleteThread).not.toHaveBeenCalled();
    fireEvent.click(getByText("削除する"));
    expect(deleteThread).toHaveBeenCalledWith("t1");
    expect(useTimelineStore.getState().selectedPlotThreadId).toBeNull();
  });

  it("中身のないスレッドの削除は確認なしで即実行", () => {
    const deleteThread = vi.fn();
    usePlotThreadStore.setState({
      threads: [thread],
      links: [],
      branches: [],
      deleteThread,
    });
    useTimelineStore.setState({
      selectedPlotLinkId: null,
      selectedPlotThreadId: "t1",
    });
    const { getByText, queryByText } = render(
      <PlotMarkerInspector width={224} onClose={vi.fn()} />,
    );
    fireEvent.click(getByText("スレッドを削除"));
    expect(deleteThread).toHaveBeenCalledWith("t1");
    expect(queryByText("削除する")).toBeNull();
  });
});
