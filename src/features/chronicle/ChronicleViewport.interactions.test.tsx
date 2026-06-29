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
    fireEvent.click(getByText("ここに出来事を作成"));
    expect(props.onCreateAt).toHaveBeenCalledTimes(1);
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
});
