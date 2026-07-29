// @vitest-environment happy-dom
import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ChronicleViewport } from "./ChronicleViewport";
import {
  getAnnouncerState,
  __resetAnnouncerForTest,
} from "@/lib/a11y/announcer";

type VP = ComponentProps<typeof ChronicleViewport>;
import {
  buildChronicleLayout,
  buildChronicleWorldGeometry,
  laneDupId,
  projectChronicleWorldGeometry,
  type LayoutEventInput,
  type LayoutLane,
} from "./chronicleLayout";
import { dayToX, zoomAt, type View } from "./chronicleAxis";
import type { ChronicleCalendar } from "./chronicleTime";
import type { MarkerEvent } from "./EventMarker";
import { endPerfSession, startPerfSession } from "@/lib/perfLog";

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
  afterEach(() => vi.unstubAllGlobals());

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

  it("横だけのマーカードラッグは日だけを変更しレーンは未指定にする", () => {
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
    expect(codexId).toBeUndefined();
    expect(props.onViewChange).not.toHaveBeenCalled(); // パンしない
  });

  it("縦だけのマーカードラッグは日付を渡さずレーンだけ移動する", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    fireEvent.mouseDown(marker, { button: 0, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 100, clientY: 80 });
    fireEvent.mouseUp(document, { clientX: 100, clientY: 80 });

    expect(props.onMoveEvent).toHaveBeenCalledTimes(1);
    expect(props.onMoveEvent.mock.calls[0][0]).toBe("e1");
    expect(props.onMoveEvent.mock.calls[0][1]).toBeNull();
  });

  it("レーン deadzone 内の縦操作に伴う小さな横ぶれは日付変更にしない", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    fireEvent.mouseDown(marker, { button: 0, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 104, clientY: 40 });
    fireEvent.mouseUp(document, { clientX: 104, clientY: 40 });

    expect(props.onMoveEvent).toHaveBeenCalledTimes(1);
    expect(props.onMoveEvent.mock.calls[0][1]).toBeNull();
  });

  it("X/Y 同量の45度ドラッグは横優勢ではないため日付変更にしない", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    fireEvent.mouseDown(marker, { button: 0, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 145, clientY: 65 });
    fireEvent.mouseUp(document, { clientX: 145, clientY: 65 });

    expect(props.onMoveEvent).toHaveBeenCalledTimes(1);
    expect(props.onMoveEvent.mock.calls[0][1]).toBeNull();
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

  it("非interactive化またはepoch変更でportalメニューと操作を即時破棄する", () => {
    const props = makeProps({
      isInteractive: true,
      interactionEpoch: "scope:1",
    });
    const { container, queryByTestId, rerender } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    fireEvent.contextMenu(track(container), { clientX: 200, clientY: 20 });
    expect(queryByTestId("chronicle-context-menu")).not.toBeNull();

    rerender(
      <ChronicleViewport {...(props as unknown as VP)} isInteractive={false} />,
    );
    expect(queryByTestId("chronicle-context-menu")).toBeNull();

    rerender(
      <ChronicleViewport
        {...(props as unknown as VP)}
        isInteractive
        interactionEpoch="scope:2"
      />,
    );
    fireEvent.contextMenu(track(container), { clientX: 200, clientY: 20 });
    expect(queryByTestId("chronicle-context-menu")).not.toBeNull();
    rerender(
      <ChronicleViewport
        {...(props as unknown as VP)}
        isInteractive
        interactionEpoch="scope:3"
      />,
    );
    expect(queryByTestId("chronicle-context-menu")).toBeNull();
  });

  it("参加レーン複製はinstance/lane identityを保ち、handleを持たず横dragでprimary laneを変えない", () => {
    const duplicateId = laneDupId("e2", "c2");
    const duplicatedEvents: LayoutEventInput[] = [
      ...events,
      { ...events[1], id: duplicateId, primaryCodexId: "c2" },
    ];
    const duplicatedLanes: LayoutLane[] = [
      lanes[0],
      {
        codexId: "c2",
        name: "ユウ",
        kind: "character",
        unassigned: false,
        eventIds: [duplicateId],
      },
    ];
    const view = { pxPerDay: 2, viewStartDay: 0 };
    const layout = buildChronicleLayout({
      events: duplicatedEvents,
      lanes: duplicatedLanes,
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
    const props = makeProps({
      view,
      layout,
      selectedEventId: "e2",
      selectedIds: new Set(["e2"]),
    });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const home = container.querySelector(
      '[data-marker-instance-id="e2"]',
    ) as HTMLElement;
    const copy = container.querySelector(
      `[data-marker-instance-id="${duplicateId}"]`,
    ) as HTMLElement;
    expect(home).not.toBeNull();
    expect(copy).not.toBeNull();
    expect(home.getAttribute("data-lane-key")).toBe("c1");
    expect(copy.getAttribute("data-lane-key")).toBe("c2");
    expect(home.querySelectorAll("[data-resize]")).toHaveLength(2);
    expect(copy.querySelector("[data-resize]")).toBeNull();
    expect(copy.querySelector("[data-edge-handle]")).toBeNull();

    const center = layout.pack.centers.get(duplicateId)!;
    const startX = center.cx + layout.worldOffsetX;
    fireEvent.mouseDown(copy, {
      button: 0,
      clientX: startX,
      clientY: center.cy,
    });
    fireEvent.mouseMove(document, {
      clientX: startX + 80,
      clientY: center.cy,
    });
    fireEvent.mouseUp(document, {
      clientX: startX + 80,
      clientY: center.cy,
    });

    expect(props.onMoveEvent).toHaveBeenCalledWith(
      "e2",
      expect.any(Number),
      undefined,
    );
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

  it("複数選択の最終 drop が縦移動だけなら一括・単独移動とも発火しない", () => {
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
    // 途中では横 threshold を超えるが、最終 drop は開始 X へ戻す。
    fireEvent.mouseMove(document, { clientX: 160, clientY: 80 });
    fireEvent.mouseUp(document, { clientX: 100, clientY: 80 });

    expect(onMoveSelected).not.toHaveBeenCalled();
    expect(props.onMoveEvent).not.toHaveBeenCalled();
  });

  it("並び順モードは単独横 drop で実日付候補を渡すが一括移動しない", () => {
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
    expect(typeof props.onMoveEvent.mock.calls[0][1]).toBe("number");
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

describe("ChronicleViewport — キーボード代替（a11y: ズーム/パン/期間端/announce）", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetAnnouncerForTest();
  });

  it("+/- でズーム（選択不要・wheel ズームのキーボード代替）", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    fireEvent.keyDown(tr, { key: "+" });
    expect(props.onViewChange).toHaveBeenCalledTimes(1);
    const zin = props.onViewChange.mock.calls[0][0] as { pxPerDay: number };
    expect(zin.pxPerDay).toBeCloseTo(2 * 1.2);
    fireEvent.keyDown(tr, { key: "-" });
    const zout = props.onViewChange.mock.calls[1][0] as { pxPerDay: number };
    // Parent がまだ再描画していなくても直前の確定 preview が操作基準になる。
    expect(zout.pxPerDay).toBeCloseTo(2);
    // Shift 併用（多くの配列で "+" は Shift が要る）でも効く。
    fireEvent.keyDown(tr, { key: "+", shiftKey: true });
    expect(props.onViewChange).toHaveBeenCalledTimes(3);
  });

  it("Ctrl+←/→ で横パン（Shift+wheel のキーボード代替・pxPerDay 維持）", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    fireEvent.keyDown(tr, { key: "ArrowRight", ctrlKey: true });
    const right = props.onViewChange.mock.calls[0][0] as {
      pxPerDay: number;
      viewStartDay: number;
    };
    expect(right.pxPerDay).toBe(2);
    expect(right.viewStartDay).toBeGreaterThan(0); // 右=後の日へ
    fireEvent.keyDown(tr, { key: "ArrowLeft", ctrlKey: true });
    const left = props.onViewChange.mock.calls[1][0] as {
      viewStartDay: number;
    };
    // Parent 再描画前の連続入力でも前の確定位置から戻る。
    expect(left.viewStartDay).toBeCloseTo(0);
    // 選択が無くても効く（選択ナビは発火しない）。
    expect(props.onSelectEvent).not.toHaveBeenCalled();
  });

  it("Home/End でデータ両端へジャンプ", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    fireEvent.keyDown(tr, { key: "Home" });
    fireEvent.keyDown(tr, { key: "End" });
    expect(props.onViewChange).toHaveBeenCalledTimes(2);
    const home = props.onViewChange.mock.calls[0][0] as {
      pxPerDay: number;
      viewStartDay: number;
    };
    const end = props.onViewChange.mock.calls[1][0] as {
      pxPerDay: number;
      viewStartDay: number;
    };
    expect(home.pxPerDay).toBe(2);
    expect(end.pxPerDay).toBe(2);
    expect(end.viewStartDay).toBeGreaterThan(home.viewStartDay);
  });

  it("Shift+←/→ で終了端・Ctrl+Shift+←/→ で開始端を伸縮（onResizeSelectedBy）", () => {
    const onResizeSelectedBy = vi.fn();
    const props = makeProps({
      selectedEventId: "e2",
      selectedIds: new Set(["e2"]),
      onResizeSelectedBy,
    });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    fireEvent.keyDown(tr, { key: "ArrowRight", shiftKey: true });
    expect(onResizeSelectedBy).toHaveBeenCalledTimes(1);
    expect(onResizeSelectedBy.mock.calls[0][0]).toBe("end");
    expect(onResizeSelectedBy.mock.calls[0][1]).toBeGreaterThan(0);
    fireEvent.keyDown(tr, { key: "ArrowLeft", shiftKey: true, ctrlKey: true });
    expect(onResizeSelectedBy).toHaveBeenCalledTimes(2);
    expect(onResizeSelectedBy.mock.calls[1][0]).toBe("start");
    expect(onResizeSelectedBy.mock.calls[1][1]).toBeLessThan(0);
    // 伸縮は選択ナビ/パンを発火しない。
    expect(props.onSelectEvent).not.toHaveBeenCalled();
    expect(props.onViewChange).not.toHaveBeenCalled();
  });

  it("ロック中は Shift+矢印の期間端伸縮をしない", () => {
    const onResizeSelectedBy = vi.fn();
    const props = makeProps({
      locked: true,
      selectedEventId: "e2",
      selectedIds: new Set(["e2"]),
      onResizeSelectedBy,
    });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    fireEvent.keyDown(track(container), {
      key: "ArrowRight",
      shiftKey: true,
    });
    expect(onResizeSelectedBy).not.toHaveBeenCalled();
  });

  it("矢印ナビで選択先のイベント名を announce する", () => {
    const props = makeProps({
      selectedEventId: "e1",
      selectedIds: new Set(["e1"]),
    });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    fireEvent.keyDown(track(container), { key: "ArrowRight" });
    expect(props.onSelectEvent).toHaveBeenCalledWith("e2");
    expect(getAnnouncerState().polite).toContain("期間"); // e2 のタイトル
  });

  it("キーボードナビ後は因果チェーン外のマーカーを dim する（選択のみでは dim しない）", () => {
    const ev3: LayoutEventInput[] = [
      ...events,
      {
        id: "e3",
        title: "無関係",
        primaryCodexId: "c1",
        kind: "generic",
        precision: "exact",
        secret: false,
        sceneLinked: true,
        startDay: 220,
        endDay: null,
      },
    ];
    const lanes3: LayoutLane[] = [
      { ...lanes[0], eventIds: ["e1", "e2", "e3"] },
    ];
    const relations = [{ causeId: "e1", effectId: "e2" }];
    const view = { pxPerDay: 2, viewStartDay: 0 };
    const layout = buildChronicleLayout({
      events: ev3,
      lanes: lanes3,
      view,
      trackW: 800,
      density: "standard",
      labelsOn: true,
      calendar: cal,
      hasCalendarAxis: true,
      dataStart: 50,
      dataEnd: 220,
      relations,
      causalConflictPairs: new Set(),
      lang: "ja",
    });
    const eventsById = new Map<string, MarkerEvent>(
      ev3.map((e) => [
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
      eventsById,
      relations,
      selectedEventId: "e1",
      selectedIds: new Set(["e1"]),
    });
    const { container, rerender } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const opacityOf = (id: string) =>
      (container.querySelector(`[data-event-id="${id}"]`) as HTMLElement).style
        .opacity;
    // 選択（prop）だけでは dim しない。
    expect(opacityOf("e3")).not.toBe("0.28");
    // 矢印ナビ e1→e2 → 親が selectedEventId を更新した状態を反映。
    fireEvent.keyDown(track(container), { key: "ArrowRight" });
    expect(props.onSelectEvent).toHaveBeenCalledWith("e2");
    rerender(
      <ChronicleViewport
        {...(props as unknown as VP)}
        selectedEventId="e2"
        selectedIds={new Set(["e2"])}
      />,
    );
    // e3 はチェーン外なので dim、e2（チェーン内）は dim しない。
    expect(opacityOf("e3")).toBe("0.28");
    expect(opacityOf("e2")).not.toBe("0.28");
  });
});

describe("ChronicleViewport — 中ドラッグパン / 日時バブル / ライブエッジ", () => {
  it("logical event数でなくparticipant copyを含むmarker instance数でwindowingを有効化する", () => {
    const logicalEvents: LayoutEventInput[] = Array.from(
      { length: 126 },
      (_, index) => ({
        id: `copied-${index}`,
        title: `出来事 ${index}`,
        primaryCodexId: "c1",
        kind: "generic" as const,
        precision: "exact" as const,
        secret: false,
        sceneLinked: true,
        startDay: 50,
        endDay: null,
      }),
    );
    const copies = logicalEvents.map((event) => ({
      ...event,
      id: laneDupId(event.id, "c2"),
      primaryCodexId: "c2",
    }));
    const view = { pxPerDay: 2, viewStartDay: 0 };
    const layout = buildChronicleLayout({
      events: [...logicalEvents, ...copies],
      lanes: [
        {
          codexId: "c1",
          name: "アヤ",
          kind: "character",
          unassigned: false,
          eventIds: logicalEvents.map((event) => event.id),
        },
        {
          codexId: "c2",
          name: "ユウ",
          kind: "character",
          unassigned: false,
          eventIds: copies.map((event) => event.id),
        },
      ],
      view,
      trackW: 800,
      density: "standard",
      labelsOn: true,
      calendar: cal,
      hasCalendarAxis: true,
      dataStart: 50,
      dataEnd: 50,
      relations: [],
      causalConflictPairs: new Set(),
      lang: "ja",
    });
    const eventsById = new Map<string, MarkerEvent>(
      logicalEvents.map((event) => [
        event.id,
        {
          id: event.id,
          title: event.title,
          kind: event.kind,
          precision: event.precision,
          secret: event.secret,
          sceneLinked: event.sceneLinked,
          primaryCodexId: event.primaryCodexId,
        },
      ]),
    );
    const props = makeProps({ view, layout, eventsById });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);

    expect(eventsById.size).toBeLessThanOrEqual(250);
    expect(layout.markerById.size).toBeGreaterThan(250);
    expect(tr).toHaveAttribute("data-chronicle-total-marker-count", "252");
    expect(
      tr.querySelector("[data-chronicle-windowed-marker-wrapper]"),
    ).not.toBeNull();
  });

  it("縦 viewport 外の大量 marker を DOM から外し、scroll 先を即時に投影する", () => {
    const manyEvents: LayoutEventInput[] = Array.from(
      { length: 300 },
      (_, index) => ({
        id: `windowed-${index}`,
        title: `出来事 ${index}`,
        primaryCodexId: "c1",
        kind: "generic" as const,
        precision: "exact" as const,
        secret: false,
        sceneLinked: true,
        startDay: 50,
        endDay: null,
      }),
    );
    const manyLanes: LayoutLane[] = [
      {
        codexId: "c1",
        name: "アヤ",
        kind: "character",
        unassigned: false,
        eventIds: manyEvents.map((event) => event.id),
      },
    ];
    const view = { pxPerDay: 2, viewStartDay: 0 };
    const relations = [{ causeId: "windowed-0", effectId: "windowed-1" }];
    const layout = buildChronicleLayout({
      events: manyEvents,
      lanes: manyLanes,
      view,
      trackW: 800,
      density: "standard",
      labelsOn: true,
      calendar: cal,
      hasCalendarAxis: true,
      dataStart: 50,
      dataEnd: 50,
      relations,
      causalConflictPairs: new Set(),
      lang: "ja",
    });
    const eventsById = new Map<string, MarkerEvent>(
      manyEvents.map((event) => [
        event.id,
        {
          id: event.id,
          title: event.title,
          kind: event.kind,
          precision: event.precision,
          secret: event.secret,
          sceneLinked: event.sceneLinked,
          primaryCodexId: event.primaryCodexId,
        },
      ]),
    );
    const props = makeProps({ view, layout, eventsById, relations });
    const bottomMarkerId = [...layout.markerById.entries()].reduce(
      (bottom, current) => (current[1].top > bottom[1].top ? current : bottom),
    )[0];
    const { container, getByTestId, rerender } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const scrollArea = getByTestId("chronicle-scroll-area");
    const tr = track(container);
    const initialWindowCount = tr.querySelectorAll("[data-event-id]").length;
    expect(initialWindowCount).toBeGreaterThan(0);
    expect(initialWindowCount).toBeLessThan(manyEvents.length);

    Object.defineProperty(scrollArea, "clientHeight", {
      configurable: true,
      value: 120,
    });

    fireEvent.scroll(scrollArea);
    const topWindowCount = tr.querySelectorAll("[data-event-id]").length;
    expect(topWindowCount).toBeGreaterThan(0);
    expect(topWindowCount).toBeLessThan(manyEvents.length);
    expect(
      tr.querySelectorAll("[data-chronicle-windowed-marker-wrapper]"),
    ).toHaveLength(topWindowCount);
    expect(tr).toHaveAttribute(
      "data-chronicle-total-event-count",
      String(manyEvents.length),
    );
    expect(tr).toHaveAttribute(
      "data-chronicle-rendered-marker-count",
      String(topWindowCount),
    );
    expect(tr).toHaveAttribute("data-chronicle-total-edge-count", "1");
    expect(tr).toHaveAttribute("data-chronicle-rendered-edge-count", "1");
    expect(tr.querySelector('[data-event-id="windowed-0"]')).not.toBeNull();

    scrollArea.scrollTop = layout.contentHeight;
    fireEvent.scroll(scrollArea);
    expect(tr.querySelector('[data-event-id="windowed-0"]')).toBeNull();
    expect(
      tr.querySelector(`[data-event-id="${bottomMarkerId}"]`),
    ).not.toBeNull();
    expect(
      tr.querySelector('[data-causal-edge="windowed-0|windowed-1"]'),
    ).toBeNull();

    rerender(
      <ChronicleViewport
        {...(props as unknown as VP)}
        selectedEventId="windowed-0"
        selectedIds={new Set(["windowed-0"])}
      />,
    );
    expect(tr.querySelector('[data-event-id="windowed-0"]')).not.toBeNull();
    expect(
      tr.querySelector('[data-causal-edge="windowed-0|windowed-1"]'),
    ).not.toBeNull();
  });

  it("小規模 Chronicle は projection window を使わず作成・削除 fade を維持する", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);

    expect(tr.querySelectorAll("[data-event-id]")).toHaveLength(events.length);
    expect(
      tr.querySelector("[data-chronicle-windowed-marker-wrapper]"),
    ).toBeNull();
    expect(tr).not.toHaveAttribute("data-chronicle-render-window-top");
  });

  it("wheel burst は DOM preview のみ更新し、80ms 後に最新 View を1回だけ確定する", () => {
    vi.useFakeTimers();
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    try {
      const onViewChange = vi.fn();
      const props = makeProps({ onViewChange });
      const { container } = render(
        <ChronicleViewport {...(props as unknown as VP)} />,
      );
      const tr = track(container);
      const world = tr.querySelector(
        "[data-chronicle-world-layer]",
      ) as HTMLElement;

      startPerfSession();
      fireEvent.wheel(tr, { deltaY: -100, clientX: 200 });
      fireEvent.wheel(tr, { deltaY: -100, clientX: 200 });
      fireEvent.wheel(tr, { deltaY: -100, clientX: 200 });
      expect(onViewChange).not.toHaveBeenCalled();

      frame(0);
      expect(world.style.transform).toContain("scaleX(");
      fireEvent.wheel(tr, { deltaY: -100, clientX: 200 });
      frame(20);
      const perfSession = endPerfSession();
      expect(perfSession?.counters["chronicle.viewportFrame.work.count"]).toBe(
        2,
      );
      expect(
        perfSession?.markStats.find(
          (entry) => entry.label === "chronicle.viewportFrame.work",
        )?.count,
      ).toBe(2);
      expect(
        perfSession?.counters["chronicle.viewportFrame.interval.count"],
      ).toBe(1);
      expect(
        perfSession?.markStats.find(
          (entry) => entry.label === "chronicle.viewportFrame.interval",
        ),
      ).toMatchObject({ count: 1, maxMs: 20 });
      vi.advanceTimersByTime(79);
      expect(onViewChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onViewChange).toHaveBeenCalledTimes(1);
      const committed = onViewChange.mock.calls[0][0] as {
        pxPerDay: number;
      };
      expect(committed.pxPerDay).toBeCloseTo(2 * 1.2 * 1.2 * 1.2 * 1.2);
    } finally {
      endPerfSession();
      vi.useRealTimers();
    }
  });

  it("wheel の 0,0 sample は zoom/commit/debounce を発生させない", () => {
    vi.useFakeTimers();
    const requestFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    try {
      const onViewChange = vi.fn();
      const props = makeProps({ onViewChange });
      const { container, unmount } = render(
        <ChronicleViewport {...(props as unknown as VP)} />,
      );

      fireEvent.wheel(track(container), {
        deltaX: 0,
        deltaY: 0,
        clientX: 200,
      });
      vi.advanceTimersByTime(200);

      expect(requestFrame).not.toHaveBeenCalled();
      expect(onViewChange).not.toHaveBeenCalled();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("wheel burst は次の pointer gesture 開始時に確定し、旧 timer は drag 中に発火しない", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    try {
      const onViewChange = vi.fn();
      const props = makeProps({ onViewChange });
      const { container, unmount } = render(
        <ChronicleViewport {...(props as unknown as VP)} />,
      );
      const tr = track(container);

      fireEvent.wheel(tr, { deltaY: -100, clientX: 200 });
      expect(onViewChange).not.toHaveBeenCalled();

      fireEvent.mouseDown(tr, { button: 0, clientX: 300, clientY: 100 });
      // pointerdown is the explicit end of the prior wheel burst.
      expect(onViewChange).toHaveBeenCalledTimes(1);
      fireEvent.mouseMove(document, { clientX: 360, clientY: 100 });
      vi.advanceTimersByTime(200);
      // The cleared wheel timer must not commit in the middle of the drag.
      expect(onViewChange).toHaveBeenCalledTimes(1);

      fireEvent.mouseUp(document, {
        button: 0,
        clientX: 360,
        clientY: 100,
      });
      expect(onViewChange).toHaveBeenCalledTimes(2);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("wheel DOM preview直後のmarker dragはpreview座標系で開始日を解決する", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    try {
      const props = makeProps();
      const { container, unmount } = render(
        <ChronicleViewport {...(props as unknown as VP)} />,
      );
      const tr = track(container);
      const marker = container.querySelector(
        '[data-event-id="e1"]',
      ) as HTMLElement;
      // 2px/day, day 50 is x=100. Zooming 1.2x around x=200 keeps
      // the pivot fixed and projects that marker to x=80.
      const previewMarkerX = 80;

      // happy-dom's WheelEvent constructor drops clientX.
      const wheel = new WheelEvent("wheel", { deltaY: -100 });
      Object.defineProperty(wheel, "clientX", {
        configurable: true,
        value: 200,
      });
      fireEvent(tr, wheel);
      fireEvent.mouseDown(marker, {
        button: 0,
        clientX: previewMarkerX,
        clientY: 20,
      });
      fireEvent.mouseMove(document, {
        clientX: previewMarkerX + 60,
        clientY: 20,
      });
      fireEvent.mouseUp(document, {
        clientX: previewMarkerX + 60,
        clientY: 20,
      });

      const movedDay = props.onMoveEvent.mock.calls[0][1] as number;
      expect(movedDay).toBeCloseTo(75);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("wheel DOM preview直後の期間resizeはpreview座標系で終了日を解決する", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    try {
      const props = makeProps();
      const { container, unmount } = render(
        <ChronicleViewport {...(props as unknown as VP)} />,
      );
      const tr = track(container);
      const handle = container.querySelector(
        '[data-event-id="e2"] [data-resize="end"]',
      ) as HTMLElement;
      // day 180 is x=360 before zoom and x=392 after a 1.2x zoom around x=200.
      const previewEndX = 392;
      const wheel = new WheelEvent("wheel", { deltaY: -100 });
      Object.defineProperty(wheel, "clientX", {
        configurable: true,
        value: 200,
      });

      fireEvent(tr, wheel);
      fireEvent.mouseDown(handle, {
        button: 0,
        clientX: previewEndX,
        clientY: 30,
      });
      fireEvent.mouseMove(document, {
        clientX: previewEndX + 60,
        clientY: 30,
      });
      fireEvent.mouseUp(document, {
        clientX: previewEndX + 60,
        clientY: 30,
      });

      expect(props.onResizeEvent).toHaveBeenCalledTimes(1);
      expect(props.onResizeEvent.mock.calls[0].slice(0, 2)).toEqual([
        "e2",
        "end",
      ]);
      expect(props.onResizeEvent.mock.calls[0][2]).toBeCloseTo(205);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("wheel DOM preview直後の因果edge dragはpreview後のhome handleからガイドを引く", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    try {
      const props = makeProps({ selectedEventId: "e1" });
      const { container, unmount } = render(
        <ChronicleViewport {...(props as unknown as VP)} />,
      );
      const tr = track(container);
      const handle = container.querySelector(
        '[data-event-id="e1"] [data-edge-handle]',
      ) as HTMLElement;
      const target = container.querySelector(
        '[data-event-id="e2"]',
      ) as HTMLElement;
      const center = props.layout.pack.centers.get("e1")!;
      const worldAnchorX = center.outX ?? center.cx;
      const previewView = zoomAt({
        view: props.view,
        pivotPx: 200,
        factor: 1.2,
      });
      const previewScale = previewView.pxPerDay / props.view.pxPerDay;
      const previewShift =
        (props.view.viewStartDay - previewView.viewStartDay) *
        previewView.pxPerDay;
      const expectedGuideX =
        props.layout.worldOffsetX * previewScale +
        previewShift +
        worldAnchorX * previewScale;
      const wheel = new WheelEvent("wheel", { deltaY: -100 });
      Object.defineProperty(wheel, "clientX", {
        configurable: true,
        value: 200,
      });
      vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

      fireEvent(tr, wheel);
      fireEvent.mouseDown(handle, {
        button: 0,
        clientX: expectedGuideX,
        clientY: center.cy,
      });
      fireEvent.mouseMove(document, { clientX: 320, clientY: center.cy });

      const guide = container.querySelector(
        "line.stroke-primary",
      ) as SVGLineElement;
      expect(Number(guide.getAttribute("x1"))).toBeCloseTo(expectedGuideX);
      expect(Number(guide.getAttribute("x2"))).toBeCloseTo(320);

      fireEvent.mouseUp(document, { clientX: 320, clientY: center.cy });
      expect(props.onCreateEdge).toHaveBeenCalledWith("e1", "e2");
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("長いpanは1 viewportのoverscanを使い切る前に中間projectionをcommitする", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);

    fireEvent.mouseDown(tr, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 700, clientY: 100 });
    expect(props.onViewChange).toHaveBeenCalledTimes(1);
    fireEvent.mouseUp(document, {
      button: 0,
      clientX: 700,
      clientY: 100,
    });
    expect(props.onViewChange.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("non-zero world offset の DOM zoom preview は pivot と論理日位置を保存する", () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const baseView = { pxPerDay: 2, viewStartDay: 10 };
    const originDay = 25;
    const worldGeometry = buildChronicleWorldGeometry({
      events,
      lanes,
      pxPerDay: baseView.pxPerDay,
      originDay,
      density: "standard",
      labelsOn: true,
      relations: [],
      causalConflictPairs: new Set(),
    });
    const layout = projectChronicleWorldGeometry({
      world: worldGeometry,
      view: baseView,
      trackW: 800,
      calendar: cal,
      hasCalendarAxis: true,
      dataStart: 50,
      dataEnd: 180,
      lang: "ja",
    });
    expect(layout.worldOffsetX).toBeCloseTo(30);

    const props = makeProps({ view: baseView, layout });
    const { container, unmount } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    try {
      const pivotPx = 200;
      const tr = track(container);
      vi.spyOn(tr, "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, 0, 800, 400),
      );
      expect(tr.getBoundingClientRect().left).toBe(0);
      // happy-dom's WheelEvent constructor currently drops clientX. Define it
      // explicitly so this test exercises browser zoom-to-cursor math.
      const wheel = new WheelEvent("wheel", { deltaY: -100 });
      Object.defineProperty(wheel, "clientX", {
        configurable: true,
        value: pivotPx,
      });
      fireEvent(tr, wheel);
      for (const callback of frames.splice(0)) callback(0);

      const world = tr.querySelector(
        "[data-chronicle-world-layer]",
      ) as HTMLElement;
      expect(world.style.transform).toContain("scaleX(");
      const match = /translateX\(([-+\d.eE]+)px\) scaleX\(([-+\d.eE]+)\)/.exec(
        world.style.transform,
      );
      expect(match).not.toBeNull();
      const translate = Number(match?.[1]);
      const scale = Number(match?.[2]);
      const nextView = zoomAt({ view: baseView, pivotPx, factor: 1.2 });
      const projectDay = (day: number) =>
        translate + (day - originDay) * baseView.pxPerDay * scale;

      const pivotDay = baseView.viewStartDay + pivotPx / baseView.pxPerDay;
      expect(projectDay(pivotDay)).toBeCloseTo(pivotPx);
      expect(projectDay(50)).toBeCloseTo(dayToX(nextView, 50));
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("スクロールバー thumb は move 中 DOM のみ追従し、mouseup で最新位置を1回確定する", () => {
    const onViewChange = vi.fn();
    const view = { pxPerDay: 10, viewStartDay: 0 };
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
    const props = makeProps({ onViewChange, view, layout });
    const { getByTestId } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const thumb = getByTestId("chronicle-scroll-thumb");
    const initialLeft = thumb.style.left;

    fireEvent.mouseDown(thumb, { button: 0, clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 120 });
    fireEvent.mouseMove(document, { clientX: 140 });
    fireEvent.mouseMove(document, { clientX: 160 });
    expect(onViewChange).not.toHaveBeenCalled();
    expect(thumb.style.left).not.toBe(initialLeft);

    fireEvent.mouseUp(document, { button: 0, clientX: 160 });
    expect(onViewChange).toHaveBeenCalledTimes(1);
    const committed = onViewChange.mock.calls[0][0] as {
      viewStartDay: number;
    };
    expect(committed.viewStartDay).toBeGreaterThan(0);
  });

  it.each([1, 2])(
    "スクロールバー thumb は button=%i では drag/commit しない",
    (button) => {
      const onViewChange = vi.fn();
      const props = makeProps({ onViewChange });
      const { getByTestId } = render(
        <ChronicleViewport {...(props as unknown as VP)} />,
      );
      const thumb = getByTestId("chronicle-scroll-thumb");
      const initialLeft = thumb.style.left;

      fireEvent.mouseDown(thumb, { button, clientX: 100 });
      fireEvent.mouseMove(document, { clientX: 180 });
      fireEvent.mouseUp(document, { button, clientX: 180 });

      expect(thumb.style.left).toBe(initialLeft);
      expect(onViewChange).not.toHaveBeenCalled();
    },
  );

  it("scrollbar は意味的な range/value/name を持ち、Arrow/Page/Home/End で水平移動できる", () => {
    const onViewChange = vi.fn();
    const view = { pxPerDay: 10, viewStartDay: 0 };
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
    const props = makeProps({
      onViewChange,
      view,
      layout,
      formatDayLabel: (day: number) => `story day ${day}`,
    });
    const { getByRole } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const scrollbar = getByRole("scrollbar", {
      name: "作中年表の水平スクロール",
    });

    expect(scrollbar).toHaveAttribute("aria-valuemin", "-10");
    expect(scrollbar).toHaveAttribute("aria-valuemax", "160");
    expect(scrollbar).toHaveAttribute("aria-valuenow", "0");
    expect(scrollbar).toHaveAttribute("aria-valuetext", "story day 0");

    expect(fireEvent.keyDown(scrollbar, { key: "ArrowRight" })).toBe(false);
    const arrowRight = onViewChange.mock.calls.at(-1)?.[0] as View;
    expect(arrowRight.viewStartDay).toBeGreaterThan(0);

    fireEvent.keyDown(scrollbar, { key: "ArrowLeft" });
    const arrowLeft = onViewChange.mock.calls.at(-1)?.[0] as View;
    expect(arrowLeft.viewStartDay).toBeCloseTo(0);

    fireEvent.keyDown(scrollbar, { key: "PageDown" });
    const pageDown = onViewChange.mock.calls.at(-1)?.[0] as View;
    expect(pageDown.viewStartDay).toBeGreaterThan(arrowRight.viewStartDay);

    fireEvent.keyDown(scrollbar, { key: "PageUp" });
    const pageUp = onViewChange.mock.calls.at(-1)?.[0] as View;
    expect(pageUp.viewStartDay).toBeCloseTo(0);

    fireEvent.keyDown(scrollbar, { key: "End" });
    expect(
      (onViewChange.mock.calls.at(-1)?.[0] as View).viewStartDay,
    ).toBeCloseTo(160);

    fireEvent.keyDown(scrollbar, { key: "Home" });
    expect(
      (onViewChange.mock.calls.at(-1)?.[0] as View).viewStartDay,
    ).toBeCloseTo(-10);
  });

  it("window blur は middle pan と thumb drag を取消し、DOM preview を確定前へ戻す", () => {
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const onViewChange = vi.fn();
    const props = makeProps({ onViewChange });
    const { container, unmount } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    const world = tr.querySelector(
      "[data-chronicle-world-layer]",
    ) as HTMLElement;
    const initialTransform = world.style.transform;
    const scrollArea = tr.parentElement as HTMLElement;
    scrollArea.scrollTop = 100;

    fireEvent.mouseDown(tr, { button: 1, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 160, clientY: 40 });
    frame(0);
    expect(tr.style.cursor).toBe("grabbing");
    expect(world.style.transform).not.toBe(initialTransform);
    expect(scrollArea.scrollTop).toBe(160);

    fireEvent.blur(window);
    expect(tr.style.cursor).not.toBe("grabbing");
    expect(world.style.transform).toBe(initialTransform);
    expect(scrollArea.scrollTop).toBe(100);
    fireEvent.mouseUp(document, { button: 1, clientX: 160, clientY: 40 });
    expect(onViewChange).not.toHaveBeenCalled();
    unmount();

    const thumbView = { pxPerDay: 10, viewStartDay: 0 };
    const thumbLayout = buildChronicleLayout({
      events,
      lanes,
      view: thumbView,
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
    const { getByTestId: getThumbByTestId } = render(
      <ChronicleViewport
        {...(makeProps({
          onViewChange,
          view: thumbView,
          layout: thumbLayout,
        }) as unknown as VP)}
      />,
    );
    const thumb = getThumbByTestId("chronicle-scroll-thumb");
    const initialLeft = thumb.style.left;
    fireEvent.mouseDown(thumb, { button: 0, clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 160 });
    expect(thumb.style.left).not.toBe(initialLeft);
    fireEvent.blur(window);
    expect(thumb.style.left).toBe(initialLeft);
    fireEvent.mouseUp(document, { button: 0, clientX: 160 });
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("keepalive-hidden 遷移で middle pan の連続 rAF と document listener を取消す", () => {
    let nextFrameId = 0;
    const pendingFrames = new Map<number, FrameRequestCallback>();
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      nextFrameId += 1;
      pendingFrames.set(nextFrameId, callback);
      return nextFrameId;
    });
    const cancelFrame = vi.fn((frameId: number) => {
      pendingFrames.delete(frameId);
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    const onViewChange = vi.fn();
    const props = makeProps({ onViewChange });
    const { container, rerender } = render(
      <ChronicleViewport {...(props as unknown as VP)} isActive />,
    );
    const tr = track(container);

    fireEvent.mouseDown(tr, { button: 1, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 124, clientY: 20 });
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(tr.style.cursor).toBe("grabbing");

    rerender(
      <ChronicleViewport {...(props as unknown as VP)} isActive={false} />,
    );
    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(pendingFrames.size).toBe(0);
    expect(tr.style.cursor).not.toBe("grabbing");
    fireEvent.mouseUp(document, {
      button: 1,
      buttons: 0,
      clientX: 124,
      clientY: 20,
    });
    expect(onViewChange).not.toHaveBeenCalled();

    fireEvent.mouseDown(tr, { button: 1, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 140, clientY: 20 });
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(tr.style.cursor).not.toBe("grabbing");
  });

  it("閾値未満の空白パン preview は mouseup で解除される", () => {
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const onViewChange = vi.fn();
    const props = makeProps({ onViewChange });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    const world = tr.querySelector(
      "[data-chronicle-world-layer]",
    ) as HTMLElement;
    const initialTransform = world.style.transform;

    fireEvent.mouseDown(tr, { button: 0, clientX: 300, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 302, clientY: 100 });
    frame(0);
    expect(world.style.transform).not.toBe(initialTransform);

    fireEvent.mouseUp(document, { clientX: 302, clientY: 100 });

    expect(onViewChange).not.toHaveBeenCalled();
    expect(world.style.transform).toBe(initialTransform);
  });

  it("中ボタンドラッグで横パン（onViewChange）＋トラックが grabbing", () => {
    const onViewChange = vi.fn();
    const props = makeProps({ onViewChange });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    fireEvent.mouseDown(tr, { button: 1, clientX: 100, clientY: 20 });
    expect(tr.style.cursor).toBe("grabbing");
    fireEvent.mouseMove(document, { clientX: 160, clientY: 20 });
    // pointermove 中は DOM transform のみ。global/local view 通知は操作終了時に集約。
    expect(onViewChange).not.toHaveBeenCalled();
    fireEvent.mouseUp(document, { clientX: 160, clientY: 20 });
    // panByPx(dx=60): viewStartDay = 0 - 60/2 = -30
    const lastCall = onViewChange.mock.calls.at(-1)![0] as {
      viewStartDay: number;
    };
    expect(lastCall.viewStartDay).toBeCloseTo(-30);
    expect(tr.style.cursor).not.toBe("grabbing");
  });

  it("pan 対象 layer は初回 rAF 前から transform origin を確定する", () => {
    const props = makeProps();
    const { container, getByTestId } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );

    const worldLayers = container.querySelectorAll<HTMLElement>(
      "[data-chronicle-world-layer]",
    );
    expect(worldLayers.length).toBeGreaterThan(0);
    for (const layer of worldLayers) {
      expect(layer.style.transformOrigin).toBe("0 0");
      // World children may sit outside the viewport-width layer and become
      // visible only after a negative pan/zoom translation. Paint containment
      // would clip them before that transform is applied.
      expect(layer.style.contain).not.toBe("paint");
    }
    expect(
      getByTestId("chronicle-viewport-projection").style.transformOrigin,
    ).toBe("0 0");
    expect(
      getByTestId("chronicle-ruler").querySelector<HTMLElement>(
        ".will-change-transform",
      )?.style.transformOrigin,
    ).toBe("0 0");
  });

  it("pointer pan 中は move 配信の間も連続 rAF で表示 frame を計測する", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);

    startPerfSession();
    fireEvent.mouseDown(tr, { button: 1, clientX: 100, clientY: 20 });
    expect(frames).toHaveLength(1);
    frames.shift()!(0);

    fireEvent.mouseMove(document, { clientX: 112, clientY: 20 });
    frames.shift()!(16);
    // No additional move: the next presented frame still belongs to the active
    // gesture, so driver/input cadence cannot look like a dropped render frame.
    frames.shift()!(32);

    fireEvent.mouseMove(document, { clientX: 124, clientY: 20 });
    frames.shift()!(48);
    fireEvent.mouseUp(document, {
      button: 1,
      buttons: 0,
      clientX: 124,
      clientY: 20,
    });

    const perfSession = endPerfSession();
    expect(
      perfSession?.counters["chronicle.viewportFrame.interval.count"],
    ).toBe(3);
    expect(
      perfSession?.markStats.find(
        (entry) => entry.label === "chronicle.viewportFrame.interval",
      )?.maxMs,
    ).toBe(16);
    expect(perfSession?.counters["chronicle.viewportFrame.work.count"]).toBe(3);
  });

  it("中ボタンドラッグで縦パン（scrollTop を移動）", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    const scrollArea = tr.parentElement as HTMLElement;
    scrollArea.scrollTop = 100;
    fireEvent.mouseDown(tr, { button: 1, clientX: 100, clientY: 100 });
    // 上へ 60px ドラッグ → コンテンツは下へスクロール: 100 - (40 - 100) = 160
    fireEvent.mouseMove(document, { clientX: 100, clientY: 40 });
    expect(scrollArea.scrollTop).toBe(160);
    fireEvent.mouseUp(document, { clientX: 100, clientY: 40 });
  });

  it("斜めパン中の縦 window commit 後も横 preview transform を復元する", () => {
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const props = makeProps();
    const { container, getByTestId } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    const scrollArea = tr.parentElement as HTMLElement;
    Object.defineProperty(scrollArea, "clientHeight", {
      configurable: true,
      value: 100,
    });
    scrollArea.scrollTop = 100;

    fireEvent.mouseDown(tr, { button: 1, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 160, clientY: 40 });
    frame(0);
    const projection = getByTestId("chronicle-viewport-projection");
    const previewTransform = projection.style.transform;
    expect(previewTransform).not.toBe("");

    // Native scroll updates verticalViewport and commits a new marker window.
    // React must not clear the concurrent horizontal imperative preview.
    fireEvent.scroll(scrollArea);
    expect(projection.style.transform).toBe(previewTransform);
    fireEvent.mouseUp(document, { button: 1, clientX: 160, clientY: 40 });
  });

  it("空白ドラッグで縦にもパンする（横=view / 縦=scrollTop）", () => {
    const onViewChange = vi.fn();
    const props = makeProps({ onViewChange });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    const scrollArea = tr.parentElement as HTMLElement;
    scrollArea.scrollTop = 100;
    fireEvent.mouseDown(tr, { button: 0, clientX: 300, clientY: 100 });
    // 斜めドラッグ: 横 +60 / 縦 上へ 60。縦: 100 - (40 - 100) = 160
    fireEvent.mouseMove(document, { clientX: 360, clientY: 40 });
    expect(scrollArea.scrollTop).toBe(160);
    expect(onViewChange).not.toHaveBeenCalled();
    fireEvent.mouseUp(document, { clientX: 360, clientY: 40 });
    // 横パンは mouseup で 1 回だけ確定される。
    expect(onViewChange).toHaveBeenCalledTimes(1);
    // ドラッグ扱いなので位置選択は発火しない
    expect(props.onSelectPosition).not.toHaveBeenCalled();
  });

  it("縦のみの空白ドラッグはクリック選択にならない（onSelectPosition 不発）", () => {
    const props = makeProps();
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const tr = track(container);
    fireEvent.mouseDown(tr, { button: 0, clientX: 300, clientY: 100 });
    // 横移動なし・縦だけ 60px 動かす
    fireEvent.mouseMove(document, { clientX: 300, clientY: 40 });
    fireEvent.mouseUp(document, { clientX: 300, clientY: 40 });
    expect(props.onSelectPosition).not.toHaveBeenCalled();
  });

  it("マーカードラッグ中に日時バブルを表示し、離すと消える（body へ portal）", () => {
    const formatDayLabel = vi.fn((d: number) => `day:${Math.round(d)}`);
    const props = makeProps({ formatDayLabel });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    fireEvent.mouseDown(marker, { button: 0, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 220, clientY: 40 });
    const bubble = document.body.querySelector(
      '[data-testid="chronicle-drag-date-bubble"]',
    );
    expect(bubble).toBeTruthy();
    expect(bubble!.textContent).toMatch(/^day:/);
    expect(formatDayLabel).toHaveBeenCalled();
    fireEvent.mouseUp(document, { clientX: 220, clientY: 40 });
    expect(
      document.body.querySelector('[data-testid="chronicle-drag-date-bubble"]'),
    ).toBeNull();
  });

  it("ドラッグ中は因果エッジがライブで引き直される（liveEdges）", () => {
    const relations = [{ causeId: "e1", effectId: "e2" }];
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
      relations,
      causalConflictPairs: new Set(),
      lang: "ja",
    });
    const props = makeProps({ layout, relations, view });
    const { container } = render(
      <ChronicleViewport {...(props as unknown as VP)} />,
    );
    const edge = () =>
      container
        .querySelector('[data-causal-edge="e1|e2"]')
        ?.getAttribute("d") ?? null;
    const before = edge();
    expect(before).toBeTruthy();
    const marker = container.querySelector(
      '[data-event-id="e1"]',
    ) as HTMLElement;
    fireEvent.mouseDown(marker, { button: 0, clientX: 100, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 300, clientY: 20 });
    const during = edge();
    expect(during).toBeTruthy();
    // 動いた端点(e1)に追従してパスが変わる。
    expect(during).not.toBe(before);
    fireEvent.mouseUp(document, { clientX: 300, clientY: 20 });
  });
});
