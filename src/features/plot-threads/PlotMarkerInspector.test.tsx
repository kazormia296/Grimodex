// @vitest-environment happy-dom
import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, waitFor, within } from "@testing-library/react";
import { PlotMarkerInspector } from "./PlotMarkerInspector";
import { usePlotThreadStore } from "./plotThreadStore";
import { useTimelineStore } from "@/features/timeline/timelineStore";
import type { PlotThreadRow, PlotThreadLinkRow } from "./api";
import {
  _resetQuiescenceParticipantsForTests,
  flushQuiescenceParticipants,
} from "@/application/lifecycle/quiescenceParticipants";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";

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
  version: 0,
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
  semanticKey: "",
  version: 0,
  createdAt: "",
  updatedAt: "",
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("PlotMarkerInspector", () => {
  beforeEach(() => {
    _resetQuiescenceParticipantsForTests();
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

  afterEach(() => {
    _resetQuiescenceParticipantsForTests();
    _resetQuiescenceLeasesForTests();
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
    const moveMarkerBundle = vi.fn(async () => {});
    const thread2: PlotThreadRow = { ...thread, id: "t2", name: "恋愛の糸" };
    usePlotThreadStore.setState({
      threads: [thread, thread2],
      moveMarkerBundle,
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
    // 「追加」で marker + branch が1つの atomic bundle として渡される。
    fireEvent.click(getByText("追加"));
    expect(moveMarkerBundle).toHaveBeenCalledWith({
      markerId: "l1",
      markerPatch: {
        threadId: "t2",
        nodeId: "s1",
      },
      branchCreates: [
        {
          fromThreadId: "t1",
          toThreadId: "t2",
          atNodeId: "s1",
          kind: "branch",
        },
      ],
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
          semanticKey: "",
          version: 0,
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

  it("strict quiescence は未blurのマーカーメモを保存する", async () => {
    const updateMarker = vi.fn().mockResolvedValue(undefined);
    usePlotThreadStore.setState({ updateMarker });
    const { container } = render(
      <PlotMarkerInspector width={224} onClose={vi.fn()} />,
    );
    const note = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "境界前のメモ" } });

    await flushQuiescenceParticipants();

    expect(updateMarker).toHaveBeenCalledWith(
      "l1",
      {
        note: "境界前のメモ",
      },
      undefined,
      { preexistingDraft: true },
    );
  });

  it("lease 中の保存 await 後も permit を引き継ぎ、最新メモまで drain する", async () => {
    const firstWrite = deferred<void>();
    const updateMarker = vi
      .fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValueOnce(undefined);
    usePlotThreadStore.setState({ updateMarker });
    const { container } = render(
      <PlotMarkerInspector width={224} onClose={vi.fn()} />,
    );
    const note = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "first" } });
    const lease = acquireQuiescenceLease("project-load");

    const flushing = flushQuiescenceParticipants();
    await waitFor(() => expect(updateMarker).toHaveBeenCalledOnce());
    fireEvent.change(note, { target: { value: "latest" } });
    firstWrite.resolve();
    await flushing;

    expect(updateMarker.mock.calls).toEqual([
      ["l1", { note: "first" }, undefined, { preexistingDraft: true }],
      ["l1", { note: "latest" }, undefined, { preexistingDraft: true }],
    ]);
    lease.release();
  });

  it("IME composition Enter/Escape ではスレッド名を確定・取消ししない", () => {
    const renameThread = vi.fn().mockResolvedValue(undefined);
    usePlotThreadStore.setState({ renameThread });
    useTimelineStore.setState({
      selectedPlotLinkId: null,
      selectedPlotThreadId: "t1",
    });
    const { container } = render(
      <PlotMarkerInspector width={224} onClose={vi.fn()} />,
    );
    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "変換中の糸" } });

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });

    expect(renameThread).not.toHaveBeenCalled();
    expect(input.value).toBe("変換中の糸");
    fireEvent.keyDown(input, { key: "Escape" });
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
