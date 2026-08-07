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
import { useMemo, useState } from "react";
import { act, fireEvent, render } from "@testing-library/react";
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

const longPanEvents: LayoutEventInput[] = Array.from(
  { length: 300 },
  (_, index) => ({
    id: `long-${index}`,
    title: `出来事 ${index}`,
    primaryCodexId: "c1",
    kind: "generic" as const,
    precision: "exact" as const,
    secret: false,
    sceneLinked: true,
    startDay: index * 10,
    endDay: null,
  }),
);

function LongPanHarness() {
  const [view, setView] = useState({ pxPerDay: 1, viewStartDay: 0 });
  const trackW = 800;
  const layout = useMemo(
    () =>
      buildChronicleLayout({
        events: longPanEvents,
        lanes: [
          {
            codexId: "c1",
            name: "アヤ",
            kind: "character",
            unassigned: false,
            eventIds: longPanEvents.map((event) => event.id),
          },
        ],
        view,
        trackW,
        density: "standard",
        labelsOn: true,
        calendar: cal,
        hasCalendarAxis: true,
        dataStart: 0,
        dataEnd: 2_990,
        relations: [],
        causalConflictPairs: new Set(),
        lang: "ja",
      }),
    [view],
  );
  const markerEvents = useMemo(
    () =>
      new Map<string, MarkerEvent>(
        longPanEvents.map((event) => [
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
      ),
    [],
  );
  return (
    <ChronicleViewport
      view={view}
      onViewChange={setView}
      onMeasureTrack={() => {}}
      layout={layout}
      eventsById={markerEvents}
      selectedEventId={null}
      activeLaneKey={null}
      conflictIds={new Set()}
      relatedIds={new Set()}
      showEdges
      labelsOn
      onSelectEvent={() => {}}
    />
  );
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

function mountInWorkspace(
  backgroundEnabled: boolean,
  glassEnabled: boolean,
  backgroundRenderer: "webgl" | "fallback" = "webgl",
) {
  const width = 900;
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
  return render(
    <div
      className="app-shell"
      style={{
        position: "fixed",
        inset: 0,
        width,
        height: 420,
      }}
    >
      <main id="main-content" style={{ width: "100%", height: "100%" }}>
        <div
          data-editor-ambient
          data-background-enabled={backgroundEnabled ? "true" : "false"}
          data-background-renderer={backgroundRenderer}
        />
        <div
          data-workspace-glass-root
          data-workspace-fluid-glass={glassEnabled ? "true" : "false"}
          style={{ width: "100%", height: "100%" }}
        >
          <section
            data-ambient-glass-surface="panel"
            className="gx-panel"
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              flexDirection: "column",
            }}
          >
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
            />
          </section>
        </div>
      </main>
    </div>,
  );
}

async function settleBrowserLayout() {
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

describe("ChronicleViewport geometry (real Chromium)", () => {
  it("長距離pan中にoverscan境界前で再投影し、新viewportのmarkerをmouseup前に描く", async () => {
    const host = document.createElement("div");
    host.style.width = `${800 + densitySpacing("standard").gutterX}px`;
    host.style.height = "420px";
    host.style.display = "flex";
    host.style.flexDirection = "column";
    document.body.appendChild(host);
    const mounted = render(<LongPanHarness />, { container: host });
    await settleBrowserLayout();

    const track = document.getElementById("chronicle-track")!;
    expect(
      mounted.container.querySelector('[data-event-id="long-170"]'),
    ).toBeNull();
    const rect = track.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;

    await act(async () => {
      fireEvent.mouseDown(track, {
        button: 0,
        clientX: startX,
        clientY: rect.top + 100,
      });
      fireEvent.mouseMove(document, {
        clientX: startX - 1_300,
        clientY: rect.top + 100,
      });
    });

    const projected = mounted.container.querySelector(
      '[data-event-id="long-170"]',
    ) as HTMLElement | null;
    expect(projected).not.toBeNull();
    const markerRect = projected!.getBoundingClientRect();
    expect(markerRect.left).toBeGreaterThanOrEqual(rect.left - 1);
    expect(markerRect.left).toBeLessThanOrEqual(rect.right + 1);

    fireEvent.mouseUp(document, {
      button: 0,
      clientX: startX - 1_300,
      clientY: rect.top + 100,
    });
    mounted.unmount();
    host.remove();
  });

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
    // clip + 塗り順の実測: マーカーのレイアウト矩形がガターへはみ出しても、
    // track の paint は境界で切れ、最前面の操作対象はガターであること。
    expect(
      getComputedStyle(container.querySelector("#chronicle-track")!).overflowX,
    ).toBe("clip");
    const px = gRect.right - 2;
    const py = mRect.top + mRect.height / 2;
    const topEl = document.elementFromPoint(px, py) as HTMLElement | null;
    expect(topEl).toBeTruthy();
    expect(
      topEl!.closest('[data-testid="chronicle-lane-gutter"]'),
    ).not.toBeNull();
    expect(topEl!.closest("[data-event-id]")).toBeNull();
  });

  it("初期可視高さに収まらないレーンでも、ガターの箱がレーン全高を覆う", async () => {
    // 親スクロール領域は flex row（高さ確定）なので、stretch だけだとガターの箱は
    // 可視高さ（flex line）で止まり、fold 外のレーンセルは箱の外へオーバーフローする。
    // その領域ではガターの操作面が無くなり、負 left の marker と pointer target の
    // 境界が崩れる（min-h-max 撤去で再発する）。
    // 10 レーン（contentHeight=520）を高さ 420 のホストに入れ、
    // viewStartDay=50 で全マーカー left≈-54（ガター内へ横スクロール済み相当）にする。
    const N = 10;
    const evs: LayoutEventInput[] = [];
    const lns: LayoutLane[] = [];
    for (let i = 1; i <= N; i++) {
      evs.push({
        id: `f${i}`,
        title: `出来事${i}`,
        primaryCodexId: `c${i}`,
        kind: "generic",
        precision: "exact",
        secret: false,
        sceneLinked: true,
        startDay: 18,
        endDay: null,
      });
      lns.push({
        codexId: `c${i}`,
        name: `人物${i}`,
        kind: "character",
        unassigned: false,
        eventIds: [`f${i}`],
      });
    }
    const view = { pxPerDay: 1.4, viewStartDay: 50 };
    const width = 900;
    const trackW = width - densitySpacing("standard").gutterX;
    const layout = buildChronicleLayout({
      events: evs,
      lanes: lns,
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
    const m = new Map<string, MarkerEvent>();
    for (const e of evs) {
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
    const gutter = getByTestId("chronicle-lane-gutter");
    const scrollArea = gutter.parentElement as HTMLElement;
    // 前提保証: fold 外レーンが存在する（コンテンツが可視高さを超えている）。
    expect(layout.contentHeight).toBeGreaterThan(scrollArea.clientHeight);
    // 核心: ガターの操作面（z-20 が効く範囲）がレーン全高以上であること。
    // 可視高さで止まると fold 外で marker より前面の操作面が失われる。
    expect(gutter.getBoundingClientRect().height).toBeGreaterThanOrEqual(
      layout.contentHeight,
    );
    // 実測ガード: 最終レーンまで縦スクロールし、fold 外だったマーカーとガターの
    // 交差点でも最前面がガター側であること（既存テストの fold 内版と同じ塗り順 gate）。
    await act(async () => {
      scrollArea.scrollTop = layout.pack.lanes[N - 1].top - 100;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const marker = container.querySelector(
      `[data-event-id="f${N}"]`,
    ) as HTMLElement;
    const gr = gutter.getBoundingClientRect();
    const mr = marker.getBoundingClientRect();
    // マーカーがガター域に実際はみ出している（テストの前提保証）。
    expect(mr.left).toBeLessThan(gr.right);
    const topEl = document.elementFromPoint(
      gr.right - 8,
      mr.top + mr.height / 2,
    ) as HTMLElement | null;
    expect(topEl).toBeTruthy();
    expect(
      topEl!.closest('[data-testid="chronicle-lane-gutter"]'),
    ).not.toBeNull();
    expect(topEl!.closest("[data-event-id]")).toBeNull();
  });

  it("WebGL Glass 時は CSS blur を重ねず Chronicle 構造面を透過し、track 境界で marker を clip する", async () => {
    const { container, getByTestId } = mountInWorkspace(true, true);
    await settleBrowserLayout();
    const host = container.querySelector<HTMLElement>(
      '[data-ambient-glass-surface="panel"]',
    )!;
    const surfaces = [
      getByTestId("chronicle-viewport"),
      getByTestId("chronicle-ruler"),
      getByTestId("chronicle-lane-gutter"),
      getByTestId("chronicle-scrollbar"),
    ];

    // GPUの最終パスがGlass blurを所有するためCSS blurは重ねない。
    expect(getComputedStyle(host).backdropFilter).toBe("none");
    for (const surface of surfaces) {
      expect(getComputedStyle(surface).backgroundColor).toBe(
        "rgba(0, 0, 0, 0)",
      );
    }
    expect(
      getComputedStyle(container.querySelector("#chronicle-track")!).overflowX,
    ).toBe("clip");
  });

  it.each([
    { backgroundEnabled: false, glassEnabled: true },
    { backgroundEnabled: true, glassEnabled: false },
  ])(
    "背景または Glass が無効なら Chronicle の外側ホストを不透明に戻す ($backgroundEnabled/$glassEnabled)",
    async ({ backgroundEnabled, glassEnabled }) => {
      const { container } = mountInWorkspace(backgroundEnabled, glassEnabled);
      await settleBrowserLayout();
      const host = container.querySelector<HTMLElement>(
        '[data-ambient-glass-surface="panel"]',
      )!;

      expect(getComputedStyle(host).backgroundColor).not.toBe(
        "rgba(0, 0, 0, 0)",
      );
      expect(getComputedStyle(host).backdropFilter).toBe("none");
    },
  );

  it("WebGL fallback 時は Chronicle の外側ホストに半透明の塗りを戻して blur を外す", async () => {
    const { container } = mountInWorkspace(true, true, "fallback");
    await settleBrowserLayout();
    const host = container.querySelector<HTMLElement>(
      '[data-ambient-glass-surface="panel"]',
    )!;

    expect(getComputedStyle(host).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(host).backdropFilter).toBe("none");
  });
});
