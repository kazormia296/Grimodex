/**
 * 実 Chromium で動かす Chronicle ビューポートの幾何 invariant テスト。
 * happy-dom は flex/grid の実寸を計算しないため、以下の整列バグは単体では捕まらない:
 *
 *   1. ルーラーのガター幅と本体レーンガター幅がズレ、目盛りとグリッド線が非整列。
 *   2. ルーラーの目盛り領域と本体トラックの左端/幅がズレ、tick が marker とずれる。
 *   3. マーカーがトラックの水平範囲外に描かれる。
 *
 * 実ブラウザで getBoundingClientRect() を測って assert し、CI で恒久ガードする。
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ChronicleViewport } from "./ChronicleViewport";
import {
  buildChronicleLayout,
  densitySpacing,
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
    title: "アヤ誕生",
    primaryCodexId: "c1",
    kind: "birth",
    precision: "exact",
    secret: false,
    sceneLinked: true,
    startDay: 18,
    endDay: null,
  },
  {
    id: "e2",
    title: "剣の修行",
    primaryCodexId: "c1",
    kind: "generic",
    precision: "exact",
    secret: false,
    sceneLinked: true,
    startDay: 400,
    endDay: 545,
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

function mount(width = 900) {
  const view = { pxPerDay: 1.4, viewStartDay: -10 };
  const trackW = width - densitySpacing("standard").gutterX;
  const layout = buildChronicleLayout({
    events,
    lanes,
    view,
    trackW,
    density: "standard",
    labelsOn: true,
    calendar: cal,
    hasCalendarAxis: true,
    dataStart: 18,
    dataEnd: 545,
    relations: [],
    causalConflictPairs: new Set(),
    lang: "ja",
  });
  const host = document.createElement("div");
  host.style.width = `${width}px`;
  host.style.height = "420px";
  host.style.display = "flex";
  host.style.flexDirection = "column";
  document.body.appendChild(host);
  const r = render(
    <ChronicleViewport
      view={view}
      onViewChange={() => {}}
      onMeasureTrack={() => {}}
      layout={layout}
      eventsById={eventsById()}
      selectedEventId={null}
      activeLaneKey={null}
      conflictIds={new Set()}
      relatedIds={new Set()}
      showEdges
      labelsOn
      onSelectEvent={() => {}}
    />,
    { container: host },
  );
  return { ...r, host };
}

describe("ChronicleViewport geometry (real Chromium)", () => {
  it("ルーラーのガター幅と本体レーンガター幅が一致する", () => {
    const { getByTestId } = mount();
    const rulerGutter = getByTestId(
      "chronicle-ruler-gutter",
    ).getBoundingClientRect();
    const laneGutter = getByTestId(
      "chronicle-lane-gutter",
    ).getBoundingClientRect();
    expect(Math.abs(rulerGutter.width - laneGutter.width)).toBeLessThan(1);
    expect(laneGutter.width).toBeGreaterThan(0);
  });

  it("ルーラーの目盛り領域と本体トラックの左端・幅が揃う", () => {
    const { getByTestId } = mount();
    const rulerTrack = getByTestId(
      "chronicle-ruler-track",
    ).getBoundingClientRect();
    const bodyTrack = document
      .getElementById("chronicle-track")!
      .getBoundingClientRect();
    expect(Math.abs(rulerTrack.left - bodyTrack.left)).toBeLessThan(1);
    expect(Math.abs(rulerTrack.width - bodyTrack.width)).toBeLessThan(1);
  });

  it("マーカーはトラックの水平範囲内に描かれる", () => {
    const { container } = mount();
    const track = document
      .getElementById("chronicle-track")!
      .getBoundingClientRect();
    const marker = container
      .querySelector('[data-event-id="e1"]')!
      .getBoundingClientRect();
    // 左端はトラック左より右、左端はトラック右端より左（オフスクリーン化していない）。
    expect(marker.left).toBeGreaterThanOrEqual(track.left - 1);
    expect(marker.left).toBeLessThanOrEqual(track.right + 1);
  });
});
