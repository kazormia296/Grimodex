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

  it("選択マーカーがガターへ左はみ出ししてもレーンヘッダーが上に来る（z順）", () => {
    // 左端付近の点マーカーを選択。left=startX-9 が負になりガター域へ侵入する状況。
    const ev2: LayoutEventInput[] = [
      {
        id: "z1",
        title: "起点",
        primaryCodexId: "c1",
        kind: "generic",
        precision: "exact",
        secret: false,
        sceneLinked: true,
        startDay: -10, // == viewStartDay → startX=0 → left=-9（負）
        endDay: null,
      },
    ];
    const lane2: LayoutLane[] = [
      {
        codexId: "c1",
        name: "アヤ",
        kind: "character",
        unassigned: false,
        eventIds: ["z1"],
      },
    ];
    const view = { pxPerDay: 1.4, viewStartDay: -10 };
    const width = 900;
    const trackW = width - densitySpacing("standard").gutterX;
    const layout = buildChronicleLayout({
      events: ev2,
      lanes: lane2,
      view,
      trackW,
      density: "standard",
      labelsOn: true,
      calendar: cal,
      hasCalendarAxis: true,
      dataStart: -10,
      dataEnd: 100,
      relations: [],
      causalConflictPairs: new Set(),
      lang: "ja",
    });
    const m = new Map<string, MarkerEvent>([
      [
        "z1",
        {
          id: "z1",
          title: "起点",
          kind: "generic",
          precision: "exact",
          secret: false,
          sceneLinked: true,
          primaryCodexId: "c1",
        },
      ],
    ]);
    const host = document.createElement("div");
    host.style.cssText =
      "width:900px;height:420px;display:flex;flex-direction:column";
    document.body.appendChild(host);
    const { getByTestId, container } = render(
      <ChronicleViewport
        view={view}
        onViewChange={() => {}}
        onMeasureTrack={() => {}}
        layout={layout}
        eventsById={m}
        selectedEventId="z1"
        activeLaneKey="c1"
        conflictIds={new Set()}
        relatedIds={new Set()}
        showEdges
        labelsOn
        onSelectEvent={() => {}}
      />,
      { container: host },
    );
    const gutter = getByTestId("chronicle-lane-gutter");
    const marker = container.querySelector(
      '[data-event-id="z1"]',
    ) as HTMLElement;
    const gz = Number(getComputedStyle(gutter).zIndex);
    const mz = Number(getComputedStyle(marker).zIndex);
    // ガターは選択マーカー(z=9)より高い z で前面に来る。
    expect(gz).toBeGreaterThan(mz);
    // z-index は位置指定要素にしか効かない。ガターが static だと z-20 が無視され
    // マーカーが前面に来る（過去の再発バグ）。position が効いていることを直接 gate する。
    // getComputedStyle().zIndex は static でも "20" を返すため、上の z 比較だけでは
    // この不具合を検出できなかった。
    expect(getComputedStyle(gutter).position).not.toBe("static");
    // 実際に左はみ出し（負 left）が起きていることも確認（テストの前提保証）。
    const gRect = gutter.getBoundingClientRect();
    const mRect = marker.getBoundingClientRect();
    expect(mRect.left).toBeLessThan(gRect.right);
    // 塗り順の実測: マーカーがガター上へはみ出す点で最前面がガター側であること。
    // （マーカーが前面なら elementFromPoint はマーカーを返す＝バグ再発）。
    const px = gRect.right - 2;
    const py = mRect.top + mRect.height / 2;
    const topEl = document.elementFromPoint(px, py) as HTMLElement | null;
    expect(topEl).toBeTruthy();
    expect(
      topEl!.closest('[data-testid="chronicle-lane-gutter"]'),
    ).not.toBeNull();
    expect(topEl!.closest("[data-event-id]")).toBeNull();
  });
});
