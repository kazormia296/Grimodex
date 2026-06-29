// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { ChronicleViewport } from "./ChronicleViewport";
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
    title: "A",
    primaryCodexId: "c1",
    kind: "generic",
    precision: "exact",
    secret: false,
    sceneLinked: true,
    startDay: 10,
    endDay: null,
  },
  {
    id: "e2",
    title: "B",
    primaryCodexId: "c1",
    kind: "generic",
    precision: "exact",
    secret: false,
    sceneLinked: true,
    startDay: 200,
    endDay: 260,
  },
  {
    id: "e3",
    title: "C",
    primaryCodexId: null,
    kind: "generic",
    precision: "unknown",
    secret: false,
    sceneLinked: false,
    startDay: 120,
    endDay: null,
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
  {
    codexId: null,
    name: "未割当",
    kind: "unassigned",
    unassigned: true,
    eventIds: ["e3"],
  },
];

const view = { pxPerDay: 2, viewStartDay: 0 };

function layout() {
  return buildChronicleLayout({
    events,
    lanes,
    view,
    trackW: 800,
    density: "standard",
    labelsOn: true,
    calendar: cal,
    hasCalendarAxis: true,
    dataStart: 10,
    dataEnd: 260,
    relations: [],
    causalConflictPairs: new Set(),
    lang: "ja",
  });
}

function eventsById() {
  const m = new Map<string, MarkerEvent>();
  for (const e of events) {
    m.set(e.id, {
      id: e.id,
      title: e.title,
      kind: e.kind,
      precision: e.precision,
      secret: e.secret,
      sceneLinked: e.sceneLinked,
      primaryCodexId: e.primaryCodexId,
    });
  }
  return m;
}

function renderViewport(over: { onSelectEvent?: (id: string) => void } = {}) {
  return render(
    <ChronicleViewport
      view={view}
      onViewChange={() => {}}
      onMeasureTrack={() => {}}
      layout={layout()}
      eventsById={eventsById()}
      selectedEventId={null}
      activeLaneKey={null}
      conflictIds={new Set()}
      relatedIds={new Set()}
      showEdges
      labelsOn
      onSelectEvent={over.onSelectEvent ?? (() => {})}
    />,
  );
}

describe("ChronicleViewport", () => {
  it("全 event のマーカーとレーンガターを描く", () => {
    const { container, getByText } = renderViewport();
    expect(container.querySelector('[data-event-id="e1"]')).toBeTruthy();
    expect(container.querySelector('[data-event-id="e2"]')).toBeTruthy();
    expect(container.querySelector('[data-event-id="e3"]')).toBeTruthy();
    expect(getByText("アヤ")).toBeTruthy();
  });

  it("interval マーカー(e2)は帯幅を持つ", () => {
    const { container } = renderViewport();
    const el = container.querySelector('[data-event-id="e2"]') as HTMLElement;
    // (260-200)*2 = 120px
    expect(el.style.width).toBe("120px");
  });

  it("マーカークリックで onSelectEvent が呼ばれる", () => {
    const onSelectEvent = vi.fn();
    const { container } = renderViewport({ onSelectEvent });
    (container.querySelector('[data-event-id="e1"]') as HTMLElement).click();
    expect(onSelectEvent).toHaveBeenCalledWith("e1");
  });
});
