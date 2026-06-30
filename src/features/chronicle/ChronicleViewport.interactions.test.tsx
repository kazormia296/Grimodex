// @vitest-environment happy-dom
import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ChronicleViewport } from "./ChronicleViewport";

type VP = ComponentProps<typeof ChronicleViewport>;
import {
  buildChronicleLayout,
  type LayoutEventInput,
  type LayoutLane,
} from "./chronicleLayout";
import type { ChronicleCalendar } from "./chronicleTime";
import type { MarkerEvent } from "./EventMarker";

const cal: ChronicleCalendar = {
  daysPerYear: 360,
  seasonBoundaries: [],
  startYear: 0,
};

const events: LayoutEventInput[] = [
  {
    id: "e1",
    title: "点",
    primaryCodexId: "c1",
    kind: "generic",
    precision: "exact",
    secret: false,
    sceneLinked: true,
    startDay: 50,
    endDay: null,
  },
  {
    id: "e2",
    title: "期間",
    primaryCodexId: "c1",
    kind: "generic",
    precision: "exact",
    secret: false,
    sceneLinked: true,
    startDay: 120,
    endDay: 180,
  },
];
const lanes: LayoutLane[] = [
  {
    codexId: "c1",
    name: "アヤ",
    kind: "character",
    unassigned: false,
    eventIds: ["e1", "e2"],
  },
];

function makeProps(over: Record<string, unknown> = {}) {
  const view = { pxPerDay: 2, viewStartDay: 0 };
  const layout = buildChronicleLayout({
    events,
    lanes,
    view,
    trackW: 800,
    density: "standard",
    labelsOn: true,
    calendar: cal,
    hasCalendarAxis: true,
    dataStart: 50,
    dataEnd: 180,
    relations: [],
    causalConflictPairs: new Set(),
    lang: "ja",
  });
  const eventsById = new Map<string, MarkerEvent>();
  for (const e of events) {
    eventsById.set(e.id, {
      id: e.id,
      title: e.title,
      kind: e.kind,
      precision: e.precision,
      secret: e.secret,
      sceneLinked: e.sceneLinked,
      primaryCodexId: e.primaryCodexId,
    });
  }
  return {
    view,
    onViewChange: vi.fn(),
    onMeasureTrack: vi.fn(),
    layout,
    eventsById,
    selectedEventId: null,
    activeLaneKey: null,
    conflictIds: new Set<string>(),
    relatedIds: new Set<string>(),
    showEdges: true,
    labelsOn: true,
    hasCalendarAxis: true,
    onSelectEvent: vi.fn(),
    onMoveEvent: vi.fn(),
    onResizeEvent: vi.fn(),
    onCreateEdge: vi.fn(),
    onCreateAt: vi.fn(),
    onSelectPosition: vi.fn(),
    onDeleteEvent: vi.fn(),
    ...over,
  };
}

function track(container: HTMLElement) {
  return container.querySelector("#chronicle-track") as HTMLElement;
}

describe("ChronicleViewport interactions (happy-dom math)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("空白ダブルクリックで onCreateAt(day, codexId)", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    fireEvent.doubleClick(track(container), { clientX: 100, clientY: 20 });
    expect(props.onCreateAt).toHaveBeenCalledTimes(1);
    const [day, codexId] = props.onCreateAt.mock.calls[0];
    expect(typeof day).toBe("number");
    expect(codexId).toBe("c1");
  });

  it("出来事のダブルクリックで onEditEvent(realId)（インスペクタを開く・新規作成しない）", () => {
    const onEditEvent = vi.fn();
    const props = makeProps({ onEditEvent });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    fireEvent.doubleClick(marker, { clientX: 100, clientY: 20 });
    expect(onEditEvent).toHaveBeenCalledTimes(1);
    expect(onEditEvent).toHaveBeenCalledWith("e1");
    // 出来事上のダブルクリックは新規作成を発火しない。
    expect(props.onCreateAt).not.toHaveBeenCalled();
  });

  it("マーカードラッグで onMoveEvent（横=日 / レーン codexId）", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    fireEvent.mouseDown(marker, { button: 0, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 160, clientY: 20 });
    fireEvent.mouseUp(document, { clientX: 160, clientY: 20 });
    expect(props.onMoveEvent).toHaveBeenCalledTimes(1);
    const [id, day, codexId] = props.onMoveEvent.mock.calls[0];
    expect(id).toBe("e1");
    expect(typeof day).toBe("number");
    expect(codexId).toBe("c1");
    expect(props.onViewChange).not.toHaveBeenCalled(); // パンしない
  });

  it("本体ドラッグの挿入位置はイベント先端基準（掴む位置に依存しない）", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = () =>
      container.querySelector('[data-event-id="e2"]') as HTMLElement;
    // e2=期間 startDay120, pxPerDay2 → 先端 x=240（バー 240..360）。
    // 先端(240)を掴んで +120px 移動 → 先端は x=360。
    fireEvent.mouseDown(marker(), { button: 0, clientX: 240, clientY: 30 });
    fireEvent.mouseMove(document, { clientX: 360, clientY: 30 });
    fireEvent.mouseUp(document, { clientX: 360, clientY: 30 });
    const dayFromStart = props.onMoveEvent.mock.calls[0][1] as number;

    props.onMoveEvent.mockClear();
    // バー中ほど(300)を掴んで 同じ +120px 移動 → 先端は同じ x=360 に着地。
    fireEvent.mouseDown(marker(), { button: 0, clientX: 300, clientY: 30 });
    fireEvent.mouseMove(document, { clientX: 420, clientY: 30 });
    fireEvent.mouseUp(document, { clientX: 420, clientY: 30 });
    const dayFromMiddle = props.onMoveEvent.mock.calls[0][1] as number;

    // 同じピクセル移動なら掴んだ位置に関係なく同じ挿入日（=先端基準。旧カーソル基準では不一致）。
    expect(dayFromStart).toBe(dayFromMiddle);
    expect(dayFromStart).toBeGreaterThan(120); // 右へ移動している
  });

  it("本体ドラッグは別マーカーへ落としても因果エッジを作らない（移動のみ）", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const e2 = container.querySelector('[data-event-id="e2"]') as HTMLElement;
    vi.spyOn(document, "elementFromPoint").mockReturnValue(e2);
    const e1 = container.querySelector('[data-event-id="e1"]') as HTMLElement;
    fireEvent.mouseDown(e1, { button: 0, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 250, clientY: 20 });
    fireEvent.mouseUp(document, { clientX: 250, clientY: 20 });
    expect(props.onCreateEdge).not.toHaveBeenCalled();
    expect(props.onMoveEvent).toHaveBeenCalledTimes(1);
    expect(props.onMoveEvent.mock.calls[0][0]).toBe("e1");
  });

  it("空白クリック（移動なし）で onSelectPosition", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    fireEvent.mouseDown(tr, { button: 0, clientX: 300, clientY: 20 });
    fireEvent.mouseUp(document, { clientX: 300, clientY: 20 });
    expect(props.onSelectPosition).toHaveBeenCalledTimes(1);
  });

  it("ロック中はマーカードラッグで onMoveEvent しない", () => {
    const props = makeProps({ locked: true });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    fireEvent.mouseDown(marker, { button: 0, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 160, clientY: 20 });
    fireEvent.mouseUp(document, { clientX: 160, clientY: 20 });
    expect(props.onMoveEvent).not.toHaveBeenCalled();
    expect(props.onViewChange).not.toHaveBeenCalled(); // マーカー上はパンもしない
  });

  it("右クリックでコンテキストメニュー→「ここに作成」で onCreateAt", () => {
    const props = makeProps();
    const { container, getByTestId, getByText } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    fireEvent.contextMenu(track(container), { clientX: 200, clientY: 20 });
    expect(getByTestId("chronicle-context-menu")).toBeTruthy();
    fireEvent.click(getByText("ここにイベントを作成"));
    expect(props.onCreateAt).toHaveBeenCalledTimes(1);
  });

  it("マーカー右クリック→「編集」で onEditEvent(id)（選択＋詳細パネルを開く）", () => {
    const onEditEvent = vi.fn();
    const props = makeProps({ onEditEvent });
    const { container, getByText } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    fireEvent.contextMenu(marker, { clientX: 100, clientY: 20 });
    fireEvent.click(getByText("編集"));
    expect(onEditEvent).toHaveBeenCalledWith("e1");
  });

  it("ドラッグ中はマーカーが追従 transform を持つ（見た目が動く）", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    fireEvent.mouseDown(marker, { button: 0, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 150, clientY: 26 });
    const moved = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    expect(moved.style.transform).toContain("translate");
    fireEvent.mouseUp(document, { clientX: 150, clientY: 26 });
    // 解放後はプレビュー解除（transform なし）。
    const after = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    expect(after.style.transform).toBe("");
  });

  it("選択中マーカーの因果エッジハンドルから D&D で onCreateEdge", () => {
    const props = makeProps({ selectedEventId: "e1" });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const handle = container.querySelector(
      '[data-event-id="e1"] [data-edge-handle]',
    ) as HTMLElement;
    expect(handle).toBeTruthy();
    const e2 = container.querySelector('[data-event-id="e2"]') as HTMLElement;
    vi.spyOn(document, "elementFromPoint").mockReturnValue(e2);
    fireEvent.mouseDown(handle, { button: 0, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 250, clientY: 20 });
    fireEvent.mouseUp(document, { clientX: 250, clientY: 20 });
    expect(props.onCreateEdge).toHaveBeenCalledWith("e1", "e2");
    expect(props.onMoveEvent).not.toHaveBeenCalled();
  });

  it("非ロックのマーカーはホバーカーソル grab（open hand）", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    expect(marker.style.cursor).toBe("grab");
  });

  it("ロック中のマーカーカーソルは default（grab にしない）", () => {
    const props = makeProps({ locked: true });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    expect(marker.style.cursor).toBe("default");
  });

  it("本体ドラッグ追従中はトラックが grabbing（grab hand）、解放で戻る", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    fireEvent.mouseDown(marker, { button: 0, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 160, clientY: 20 });
    expect(track(container).style.cursor).toBe("grabbing");
    fireEvent.mouseUp(document, { clientX: 160, clientY: 20 });
    expect(track(container).style.cursor).not.toBe("grabbing");
  });

  it("期間端ハンドルのドラッグで onResizeEvent", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const handle = container.querySelector(
      '[data-event-id="e2"] [data-resize="end"]',
    ) as HTMLElement;
    expect(handle).toBeTruthy();
    fireEvent.mouseDown(handle, { button: 0, clientX: 360, clientY: 30 });
    fireEvent.mouseMove(document, { clientX: 420, clientY: 30 });
    fireEvent.mouseUp(document, { clientX: 420, clientY: 30 });
    expect(props.onResizeEvent).toHaveBeenCalledTimes(1);
    expect(props.onResizeEvent.mock.calls[0][0]).toBe("e2");
    expect(props.onResizeEvent.mock.calls[0][1]).toBe("end");
  });

  it("複数選択中のマーカー本体ドラッグは onMoveSelected（一括移動・全件追従）", () => {
    const onMoveSelected = vi.fn();
    const props = makeProps({
      selectedIds: new Set(["e1", "e2"]),
      selectedEventId: "e1",
      onMoveSelected,
    });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    fireEvent.mouseDown(marker, { button: 0, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 200, clientY: 20 });
    // 一括ドラッグ中は選択全件が translate 追従する。
    expect(
      (container.querySelector('[data-event-id="e1"]') as HTMLElement).style
        .transform,
    ).toContain("translate");
    expect(
      (container.querySelector('[data-event-id="e2"]') as HTMLElement).style
        .transform,
    ).toContain("translate");
    fireEvent.mouseUp(document, { clientX: 200, clientY: 20 });
    expect(onMoveSelected).toHaveBeenCalledTimes(1);
    expect(onMoveSelected.mock.calls[0][0]).toBe("e1"); // primaryId
    expect(typeof onMoveSelected.mock.calls[0][1]).toBe("number"); // newStartDay
    expect(props.onMoveEvent).not.toHaveBeenCalled(); // 単独移動は呼ばれない
  });

  it("並び順モード(暦軸なし)では一括移動しない（単独扱い・全件追従しない）", () => {
    const onMoveSelected = vi.fn();
    const props = makeProps({
      hasCalendarAxis: false,
      selectedIds: new Set(["e1", "e2"]),
      selectedEventId: "e1",
      onMoveSelected,
    });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    fireEvent.mouseDown(marker, { button: 0, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 200, clientY: 20 });
    // e2 は追従しない（bulk 非成立）。
    expect(
      (container.querySelector('[data-event-id="e2"]') as HTMLElement).style
        .transform,
    ).toBe("");
    fireEvent.mouseUp(document, { clientX: 200, clientY: 20 });
    expect(onMoveSelected).not.toHaveBeenCalled();
    expect(props.onMoveEvent).toHaveBeenCalledTimes(1);
  });

  it("非選択マーカーのドラッグは単独移動のまま（onMoveEvent）", () => {
    const onMoveSelected = vi.fn();
    // e2 だけ選択した状態で e1 を掴む → e1 は選択外なので単独移動。
    const props = makeProps({
      selectedIds: new Set(["e2"]),
      selectedEventId: "e2",
      onMoveSelected,
    });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    fireEvent.mouseDown(marker, { button: 0, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 200, clientY: 20 });
    fireEvent.mouseUp(document, { clientX: 200, clientY: 20 });
    expect(onMoveSelected).not.toHaveBeenCalled();
    expect(props.onMoveEvent).toHaveBeenCalledTimes(1);
    expect(props.onMoveEvent.mock.calls[0][0]).toBe("e1");
  });

  it("修飾なし矢印で選択を移動（→=同レーンの次イベント / ←=前）", () => {
    // e1(startDay50) と e2(startDay120) は同じレーン c1（時間順 e1→e2）。
    const p1 = makeProps({
      selectedEventId: "e1",
      selectedIds: new Set(["e1"]),
    });
    const r1 = render(<ChronicleViewport {...(p1 as unknown as VP)} />);
    fireEvent.keyDown(track(r1.container), { key: "ArrowRight" });
    expect(p1.onSelectEvent).toHaveBeenCalledWith("e2");

    const p2 = makeProps({
      selectedEventId: "e2",
      selectedIds: new Set(["e2"]),
    });
    const r2 = render(<ChronicleViewport {...(p2 as unknown as VP)} />);
    fireEvent.keyDown(track(r2.container), { key: "ArrowLeft" });
    expect(p2.onSelectEvent).toHaveBeenCalledWith("e1");
  });

  it("修飾なし矢印はナッジしない（nudge は呼ばれない）", () => {
    const onNudgeSelected = vi.fn();
    const props = makeProps({
      selectedEventId: "e1",
      selectedIds: new Set(["e1"]),
      onNudgeSelected,
    });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    fireEvent.keyDown(track(container), { key: "ArrowRight" });
    expect(onNudgeSelected).not.toHaveBeenCalled();
  });

  it("↑/↓で隣レーンの時間最近傍へ移動", () => {
    const ev2: LayoutEventInput[] = [
      {
        id: "a1",
        title: "A1",
        primaryCodexId: "c1",
        kind: "generic",
        precision: "exact",
        secret: false,
        sceneLinked: true,
        startDay: 100,
        endDay: null,
      },
      {
        id: "b1",
        title: "B1",
        primaryCodexId: "c2",
        kind: "generic",
        precision: "exact",
        secret: false,
        sceneLinked: true,
        startDay: 104,
        endDay: null,
      },
    ];
    const lanes2: LayoutLane[] = [
      {
        codexId: "c1",
        name: "アヤ",
        kind: "character",
        unassigned: false,
        eventIds: ["a1"],
      },
      {
        codexId: "c2",
        name: "ボロ",
        kind: "character",
        unassigned: false,
        eventIds: ["b1"],
      },
    ];
    const view = { pxPerDay: 2, viewStartDay: 0 };
    const layout = buildChronicleLayout({
      events: ev2,
      lanes: lanes2,
      view,
      trackW: 800,
      density: "standard",
      labelsOn: true,
      calendar: cal,
      hasCalendarAxis: true,
      dataStart: 100,
      dataEnd: 104,
      relations: [],
      causalConflictPairs: new Set(),
      lang: "ja",
    });
    const m = new Map<string, MarkerEvent>(
      ev2.map((e) => [
        e.id,
        {
          id: e.id,
          title: e.title,
          kind: e.kind,
          precision: e.precision,
          secret: e.secret,
          sceneLinked: e.sceneLinked,
          primaryCodexId: e.primaryCodexId,
        },
      ]),
    );
    const props = makeProps({
      layout,
      eventsById: m,
      selectedEventId: "a1",
      selectedIds: new Set(["a1"]),
    });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    fireEvent.keyDown(track(container), { key: "ArrowDown" });
    expect(props.onSelectEvent).toHaveBeenCalledWith("b1");
  });

  it("↑/↓は隣レーンが無ければ無反応（単一レーン）", () => {
    const props = makeProps({
      selectedEventId: "e1",
      selectedIds: new Set(["e1"]),
    });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    fireEvent.keyDown(track(container), { key: "ArrowUp" });
    fireEvent.keyDown(track(container), { key: "ArrowDown" });
    expect(props.onSelectEvent).not.toHaveBeenCalled();
  });

  it("Alt+矢印=ズームグリッド単位でナッジ（向き符号・Alt+Shiftは粗グリッドで大）", () => {
    const onNudgeSelected = vi.fn();
    const props = makeProps({
      selectedIds: new Set(["e1"]),
      selectedEventId: "e1",
      onNudgeSelected,
    });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    const last = () => onNudgeSelected.mock.calls.at(-1)![0] as number;
    fireEvent.keyDown(tr, { key: "ArrowRight", altKey: true });
    const right = last();
    expect(right).toBeGreaterThan(0); // 右=正
    // グリッド単位（=日単位固定ではない）。pxPerDay=2 のこの layout は月グリッド(~30日)。
    expect(right).toBeGreaterThan(1);
    fireEvent.keyDown(tr, { key: "ArrowLeft", altKey: true });
    expect(last()).toBeCloseTo(-right); // 左=同量の負
    fireEvent.keyDown(tr, { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(last()).toBeGreaterThan(right); // Alt+Shift=粗グリッドでより大きく
    // ナビゲーション（選択移動）は起きない。
    expect(props.onSelectEvent).not.toHaveBeenCalled();
  });

  it("Delete/Backspace で一括削除、Escape で選択解除", () => {
    const onDeleteSelected = vi.fn();
    const onClearSelection = vi.fn();
    const props = makeProps({
      selectedIds: new Set(["e1", "e2"]),
      selectedEventId: "e1",
      onDeleteSelected,
      onClearSelection,
    });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    fireEvent.keyDown(tr, { key: "Backspace" });
    expect(onDeleteSelected).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(tr, { key: "Escape" });
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("選択なしならキーボードは無反応", () => {
    const onDeleteSelected = vi.fn();
    const onNudgeSelected = vi.fn();
    const props = makeProps({ onDeleteSelected, onNudgeSelected });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    fireEvent.keyDown(tr, { key: "Delete" });
    fireEvent.keyDown(tr, { key: "ArrowRight" });
    fireEvent.keyDown(tr, { key: "ArrowRight", altKey: true });
    expect(onDeleteSelected).not.toHaveBeenCalled();
    expect(onNudgeSelected).not.toHaveBeenCalled();
    expect(props.onSelectEvent).not.toHaveBeenCalled();
  });

  it("ロック中は Alt+矢印のナッジをしない（Delete は可）", () => {
    const onNudgeSelected = vi.fn();
    const onDeleteSelected = vi.fn();
    const props = makeProps({
      locked: true,
      selectedIds: new Set(["e1"]),
      selectedEventId: "e1",
      onNudgeSelected,
      onDeleteSelected,
    });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    fireEvent.keyDown(tr, { key: "ArrowRight", altKey: true });
    expect(onNudgeSelected).not.toHaveBeenCalled();
    fireEvent.keyDown(tr, { key: "Delete" });
    expect(onDeleteSelected).toHaveBeenCalledTimes(1);
  });
});
