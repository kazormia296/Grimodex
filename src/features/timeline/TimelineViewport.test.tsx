// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { TimelineViewport } from "./TimelineViewport";
import { zoomFactorFromWheel, computeZoomScrollLeft } from "./timelineZoom";
import { useTimelineStore } from "./timelineStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { buildPlotLaneModel } from "@/features/plot-threads/plotThreadLaneModel";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { endPerfSession, startPerfSession } from "@/lib/perfLog";

/** reduced-motion を強制（アニメ無し＝即時確定）して toggle/settled を決定的に検証する。 */
function setReduceMotion(on: boolean) {
  useSettingsStore.setState((s) => ({
    cache: { ...s.cache, "display.reduceMotion": on ? "true" : "false" },
  }));
}

function svgTranslateY(element: Element): number {
  const transform = element.getAttribute("transform") ?? "";
  const match = /translate\(0[ ,](-?\d+(?:\.\d+)?)\)/.exec(transform);
  return match ? Number(match[1]) : 0;
}

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(), isTauri: () => false }));

// buildPlotLaneModel を実装そのままの spy でラップする（挙動は actual と同一）。
// マーカードラッグ中に mousemove 毎のフルレーン再構築が走らないことを検証する。
vi.mock(
  "@/features/plot-threads/plotThreadLaneModel",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/features/plot-threads/plotThreadLaneModel")
      >();
    return { ...actual, buildPlotLaneModel: vi.fn(actual.buildPlotLaneModel) };
  },
);

const mockScene: TreeNodeData = {
  id: "scene-1",
  projectId: "proj-1",
  parentId: null,
  nodeType: "scene",
  title: "Scene 1",
  synopsis: null,

  intent: null,
  sortOrder: "a0",
  status: "draft",
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  createdAt: "2024-01-01T00:00:00Z",

  charCount: 0,
  updatedAt: "2024-01-01T00:00:00Z",
};

function resetStore() {
  useTreeStore.setState({ activeSceneId: "" });
  useTimelineStore.setState({
    axisMode: "reading",
    spacingMode: "uniform",
    showThreads: false,
    plotSubwaySort: false,
    zoom: 1,
    scrollOffset: 0,
    selectedNodeIds: [],
    inspectorOpen: false,
    display: {
      showTitles: true,
      showChapterNumbers: true,
      showPhasePins: false,
      showThreadGaps: false,
      showStructureAnalysis: false,
    },
  });
  usePlotThreadStore.setState({
    threads: [],
    links: [],
    branches: [],
    loading: false,
  });
}

describe("TimelineViewport – scroll handling (#2)", () => {
  beforeEach(resetStore);

  it("ユーザースクロールで setScrollOffset が呼ばれる", () => {
    const { getByTestId } = render(
      <TimelineViewport scenes={[mockScene]} onSelectScene={vi.fn()} />,
    );
    const container = getByTestId("timeline-scroll-container");
    Object.defineProperty(container, "scrollLeft", {
      configurable: true,
      get: () => 200,
    });
    fireEvent.scroll(container);
    expect(useTimelineStore.getState().scrollOffset).toBe(200);
  });

  it("isRestoringRef が true のとき scroll イベントは store を更新しない", async () => {
    const { getByTestId } = render(
      <TimelineViewport scenes={[mockScene]} onSelectScene={vi.fn()} />,
    );
    const container = getByTestId("timeline-scroll-container");

    // scrollLeft を 300 に設定してストアを更新 → useEffect が isRestoringRef=true にして scrollLeft を復元しようとする
    Object.defineProperty(container, "scrollLeft", {
      configurable: true,
      writable: true,
      value: 0,
    });
    act(() => {
      useTimelineStore.setState({ scrollOffset: 300 });
    });

    // isRestoringRef が true の間に scroll イベントを発火させる (rAF前)
    fireEvent.scroll(container);

    // isRestoringRef が true なので scrollOffset は 300 のまま (0 に戻らない)
    expect(useTimelineStore.getState().scrollOffset).toBe(300);
  });
});

describe("TimelineViewport – ref callback stability (Bug 2)", () => {
  beforeEach(resetStore);

  it("forwardedRef が変わらない限り ref コールバックは同一インスタンス", () => {
    const externalRef = { current: null as HTMLDivElement | null };
    const callbacks: unknown[] = [];

    const TestWrapper = ({ id }: { id: number }) => {
      void id;
      return (
        <TimelineViewport
          scenes={[mockScene]}
          onSelectScene={vi.fn()}
          ref={externalRef}
        />
      );
    };

    const { rerender, getByTestId } = render(<TestWrapper id={1} />);
    const container = getByTestId("timeline-scroll-container");
    callbacks.push((container as HTMLDivElement & { _ref?: unknown })._ref);

    rerender(<TestWrapper id={2} />);

    // 再レンダー後も externalRef.current が null でないことを確認
    expect(externalRef.current).not.toBeNull();
  });
});

describe("TimelineViewport – Ctrl/Shift click selection (#4)", () => {
  const scene1: TreeNodeData = { ...mockScene, id: "s1", title: "Scene 1" };
  const scene2: TreeNodeData = { ...mockScene, id: "s2", title: "Scene 2" };
  const scene3: TreeNodeData = { ...mockScene, id: "s3", title: "Scene 3" };

  beforeEach(() => {
    resetStore();
  });

  it("plain click → calls onSelectScene (single select)", () => {
    const onSelectScene = vi.fn();
    const { container } = render(
      <TimelineViewport
        scenes={[scene1, scene2]}
        onSelectScene={onSelectScene}
      />,
    );
    const circle = container.querySelector('[data-node-id="s1"] circle');
    fireEvent.click(circle!);
    expect(onSelectScene).toHaveBeenCalledWith("s1");
  });

  it("Ctrl+click → toggleSelect (adds), does NOT call onSelectScene", () => {
    const onSelectScene = vi.fn();
    const { container } = render(
      <TimelineViewport
        scenes={[scene1, scene2]}
        onSelectScene={onSelectScene}
      />,
    );
    const circle = container.querySelector('[data-node-id="s1"] circle');
    fireEvent.click(circle!, { ctrlKey: true });
    expect(useTimelineStore.getState().selectedNodeIds).toContain("s1");
    expect(onSelectScene).not.toHaveBeenCalled();
  });

  it("Ctrl+click on already-selected → toggleSelect (removes)", () => {
    useTimelineStore.setState({ selectedNodeIds: ["s1"] });
    const { container } = render(
      <TimelineViewport scenes={[scene1, scene2]} onSelectScene={vi.fn()} />,
    );
    const circle = container.querySelector('[data-node-id="s1"] circle');
    fireEvent.click(circle!, { ctrlKey: true });
    expect(useTimelineStore.getState().selectedNodeIds).not.toContain("s1");
  });

  it("Shift+click → rangeSelectTo, does NOT call onSelectScene", () => {
    useTimelineStore.getState().selectNode("s1");
    const onSelectScene = vi.fn();
    const { container } = render(
      <TimelineViewport
        scenes={[scene1, scene2, scene3]}
        onSelectScene={onSelectScene}
      />,
    );
    const circle3 = container.querySelector('[data-node-id="s3"] circle');
    fireEvent.click(circle3!, { shiftKey: true });
    const ids = useTimelineStore.getState().selectedNodeIds;
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
    expect(ids).toContain("s3");
    expect(onSelectScene).not.toHaveBeenCalled();
  });
});

describe("TimelineViewport – threads モード", () => {
  beforeEach(resetStore);

  it("threads モードでプロットスレッドのレーンとマーカーを描画する", () => {
    useTimelineStore.setState({ showThreads: true });
    usePlotThreadStore.setState({
      threads: [
        {
          id: "t1",
          projectId: "proj-1",
          name: "復讐の糸",
          color: "#c33",
          description: null,
          sortOrder: "a0",
          startNodeId: null,
          endNodeId: null,
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      links: [
        {
          id: "l1",
          threadId: "t1",
          nodeId: "scene-1",
          phaseType: "introduce",
          note: null,
          sortOrder: null,
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
    });

    const onSelectMarker = vi.fn();
    const { getByText, getByTestId } = render(
      <TimelineViewport
        scenes={[mockScene]}
        onSelectScene={vi.fn()}
        onSelectMarker={onSelectMarker}
      />,
    );

    // レーン見出しが出る
    expect(getByText("復讐の糸")).toBeTruthy();
    // マーカー＝チップ。mousedown→（移動なし）mouseup で選択（クリック相当）。
    const marker = getByTestId("plot-marker-l1");
    expect(marker).toBeTruthy();
    fireEvent.mouseDown(marker, { clientX: 50, clientY: 50 });
    fireEvent.mouseUp(document, { clientX: 50, clientY: 50 });
    expect(onSelectMarker).toHaveBeenCalledWith("l1");
  });

  it("固定スレッドタイトル列とカプセルの背景を半透明で描画する", () => {
    useTimelineStore.setState({ showThreads: true });
    usePlotThreadStore.setState({
      threads: [
        {
          id: "t1",
          projectId: "proj-1",
          name: "復讐の糸",
          color: "#c33",
          description: null,
          sortOrder: "a0",
          startNodeId: null,
          endNodeId: null,
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      links: [],
      loading: false,
    });

    const { getByTestId } = render(
      <TimelineViewport scenes={[mockScene]} onSelectScene={vi.fn()} />,
    );

    expect(
      getByTestId("timeline-thread-label-backdrop").getAttribute(
        "fill-opacity",
      ),
    ).toBe("0.7");
    expect(
      getByTestId("plot-lane-label-t1")
        .querySelector("rect")
        ?.getAttribute("fill-opacity"),
    ).toBe("0.84");
  });

  it("オーバーレイ: スレッド表示中でもシーンのドットは描画する", () => {
    useTimelineStore.setState({ showThreads: true });
    const { container } = render(
      <TimelineViewport scenes={[mockScene]} onSelectScene={vi.fn()} />,
    );
    // モード分割を廃止し、シーン行はスレッド表示中も常に出る（オーバーレイ）。
    expect(container.querySelector('[data-node-id="scene-1"]')).toBeTruthy();
  });

  it("レーンをダブルクリックすると最寄りシーンに develop マーカーを追加する", () => {
    const addMarker = vi.fn();
    useTimelineStore.setState({ showThreads: true });
    usePlotThreadStore.setState({
      threads: [
        {
          id: "t1",
          projectId: "proj-1",
          name: "復讐の糸",
          color: null,
          description: null,
          sortOrder: "a0",
          startNodeId: null,
          endNodeId: null,
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      links: [],
      loading: false,
      addMarker,
    });
    const { getByTestId } = render(
      <TimelineViewport scenes={[mockScene]} onSelectScene={vi.fn()} />,
    );
    fireEvent.doubleClick(getByTestId("plot-lane-hit-t1"));
    expect(addMarker).toHaveBeenCalledWith("t1", "scene-1", "develop");
  });

  it("scheduledCount===0（全シーン未配置）ではダブルクリックで追加しない", () => {
    const addMarker = vi.fn();
    useTimelineStore.setState({ showThreads: true, axisMode: "story" });
    usePlotThreadStore.setState({
      threads: [
        {
          id: "t1",
          projectId: "p",
          name: "t1",
          color: null,
          description: null,
          sortOrder: "a0",
          startNodeId: null,
          endNodeId: null,
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      links: [],
      branches: [],
      loading: false,
      addMarker,
    });
    const { getByTestId } = render(
      <TimelineViewport
        scenes={[mockScene]}
        onSelectScene={vi.fn()}
        unscheduledStartIndex={0}
      />,
    );
    fireEvent.doubleClick(getByTestId("plot-lane-hit-t1"));
    expect(addMarker).not.toHaveBeenCalled();
  });
});

describe("TimelineViewport – マウスホイールでズーム", () => {
  beforeEach(resetStore);

  function renderViewport() {
    const { getByTestId } = render(
      <TimelineViewport scenes={[mockScene]} onSelectScene={vi.fn()} />,
    );
    return getByTestId("timeline-scroll-container");
  }

  it("プレーンなホイール（縦回転 上）でズームインする（連続係数）", () => {
    const container = renderViewport();
    act(() => {
      fireEvent.wheel(container, { deltaY: -100, deltaX: 0 });
    });
    // 固定 1.25x ではなく deltaY 量ベースの連続係数で拡大する。
    expect(useTimelineStore.getState().zoom).toBeCloseTo(
      zoomFactorFromWheel(-100),
    );
  });

  it("プレーンなホイール（縦回転 下）でズームアウトする（連続係数）", () => {
    const container = renderViewport();
    act(() => {
      fireEvent.wheel(container, { deltaY: 100, deltaX: 0 });
    });
    expect(useTimelineStore.getState().zoom).toBeCloseTo(
      zoomFactorFromWheel(100),
    );
  });

  it("小さな deltaY（トラックパッド）は細かい連続ステップでズームする", () => {
    const container = renderViewport();
    act(() => {
      fireEvent.wheel(container, { deltaY: -8, deltaX: 0 });
    });
    const z = useTimelineStore.getState().zoom;
    // 旧実装は符号だけ見て 1.25x 固定だった。連続化で微小ステップになる。
    expect(z).toBeGreaterThan(1);
    expect(z).toBeLessThan(1.05);
    expect(z).toBeCloseTo(zoomFactorFromWheel(-8));
  });

  it("Shift+ホイールはズームせず横スクロールに委ねる", () => {
    const container = renderViewport();
    // happy-dom の WheelEvent は init の shiftKey を取り込まないため明示的に付与する。
    const ev = new WheelEvent("wheel", {
      deltaY: -100,
      deltaX: 0,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(ev, "shiftKey", { value: true, configurable: true });
    act(() => {
      container.dispatchEvent(ev);
    });
    expect(useTimelineStore.getState().zoom).toBe(1);
  });

  it("横優位の入力（トラックパッド横スワイプ）はズームしない", () => {
    const container = renderViewport();
    act(() => {
      fireEvent.wheel(container, { deltaY: 5, deltaX: -120 });
    });
    expect(useTimelineStore.getState().zoom).toBe(1);
  });

  it("deltaX=deltaY=0（慣性スクロール終端）でも誤ズームしない", () => {
    const container = renderViewport();
    act(() => {
      fireEvent.wheel(container, { deltaY: 0, deltaX: 0 });
    });
    expect(useTimelineStore.getState().zoom).toBe(1);
  });

  /**
   * happy-dom は実寸レイアウトを測らないため、コンテナの矩形・scrollWidth/clientWidth・
   * scrollLeft を stub し、ホイールズーム後に scrollLeft が「カーソル下の点を固定する」
   * 値へ調整されることを検証する（zoom-to-cursor の配線ゲート。算術自体は
   * timelineZoom.test.ts の computeZoomScrollLeft で別途検証）。
   */
  function stubScrollGeometry(
    container: HTMLElement,
    initialScrollLeft: number,
  ) {
    container.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 800,
        bottom: 200,
        width: 800,
        height: 200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    Object.defineProperty(container, "clientWidth", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(container, "scrollWidth", {
      configurable: true,
      value: 100000,
    });
    let sl = initialScrollLeft;
    Object.defineProperty(container, "scrollLeft", {
      configurable: true,
      get: () => sl,
      set: (v: number) => {
        sl = v;
      },
    });
  }

  /** init を無視する happy-dom の WheelEvent 制約を避け、必要プロパティを直接定義する。 */
  function dispatchWheel(
    container: HTMLElement,
    { deltaY, clientX }: { deltaY: number; clientX: number },
  ) {
    const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "deltaY", { value: deltaY, configurable: true });
    Object.defineProperty(ev, "deltaX", { value: 0, configurable: true });
    Object.defineProperty(ev, "clientX", {
      value: clientX,
      configurable: true,
    });
    act(() => {
      container.dispatchEvent(ev);
    });
  }

  function manyScenes() {
    return Array.from({ length: 20 }, (_, i) => ({
      ...mockScene,
      id: `s${i}`,
      sortOrder: `a${i}`,
    }));
  }

  it("ズームイン後 scrollLeft はカーソル下の点を固定する値へ調整される", () => {
    const { getByTestId } = render(
      <TimelineViewport scenes={manyScenes()} onSelectScene={vi.fn()} />,
    );
    const container = getByTestId("timeline-scroll-container");
    stubScrollGeometry(container, 100);
    // padLeft=PAD_LEFT=48（showThreads=false）, cursorX=400, zoom 1→連続係数。
    const nextZoom = zoomFactorFromWheel(-100);
    dispatchWheel(container, { deltaY: -100, clientX: 400 });
    expect(useTimelineStore.getState().zoom).toBeCloseTo(nextZoom);
    // scrollLeft はカーソル下の点を固定する値（算術は computeZoomScrollLeft で検証済）。
    expect(container.scrollLeft).toBeCloseTo(
      computeZoomScrollLeft(100, 400, 48, 1, nextZoom),
      4,
    );
  });

  it("ズームアウトでもカーソル基準で scrollLeft を調整する", () => {
    useTimelineStore.setState({ zoom: 2 });
    const { getByTestId } = render(
      <TimelineViewport scenes={manyScenes()} onSelectScene={vi.fn()} />,
    );
    const container = getByTestId("timeline-scroll-container");
    stubScrollGeometry(container, 600);
    // zoom 2 → 2×連続係数。cursorX=300, pad=48。
    const nextZoom = 2 * zoomFactorFromWheel(100);
    dispatchWheel(container, { deltaY: 100, clientX: 300 });
    const z = useTimelineStore.getState().zoom;
    expect(z).toBeCloseTo(nextZoom);
    expect(container.scrollLeft).toBeCloseTo(
      computeZoomScrollLeft(600, 300, 48, 2, nextZoom),
      3,
    );
  });

  it("ズーム限界（クランプで倍率不変）では scrollLeft を変えない", () => {
    useTimelineStore.setState({ zoom: 4 }); // ZOOM_MAX
    const { getByTestId } = render(
      <TimelineViewport scenes={manyScenes()} onSelectScene={vi.fn()} />,
    );
    const container = getByTestId("timeline-scroll-container");
    stubScrollGeometry(container, 777);
    dispatchWheel(container, { deltaY: -100, clientX: 400 }); // さらにズームイン不可
    expect(useTimelineStore.getState().zoom).toBe(4);
    expect(container.scrollLeft).toBe(777); // 不変
  });
});

describe("TimelineViewport – 中ボタン(ホイール)ドラッグでパン", () => {
  beforeEach(resetStore);

  /** scrollLeft/scrollTop を観測可能な可変ストレージに差し替える（happy-dom は実寸
   *  レイアウトを測らずデフォルト 0 のため）。 */
  function stubScroll(el: HTMLElement, left = 0, top = 0) {
    let sl = left;
    let st = top;
    Object.defineProperty(el, "scrollLeft", {
      configurable: true,
      get: () => sl,
      set: (v: number) => {
        sl = v;
      },
    });
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => st,
      set: (v: number) => {
        st = v;
      },
    });
  }

  /** init を無視する happy-dom の制約を避け、button/clientX/clientY を直接定義する。 */
  function mouse(
    target: EventTarget,
    type: string,
    {
      button = 0,
      clientX = 0,
      clientY = 0,
    }: { button?: number; clientX?: number; clientY?: number },
  ) {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "button", { value: button, configurable: true });
    Object.defineProperty(ev, "clientX", {
      value: clientX,
      configurable: true,
    });
    Object.defineProperty(ev, "clientY", {
      value: clientY,
      configurable: true,
    });
    act(() => {
      target.dispatchEvent(ev);
    });
    return ev;
  }

  function panScenes() {
    return Array.from({ length: 20 }, (_, i) => ({
      ...mockScene,
      id: `s${i}`,
      sortOrder: `a${i}`,
    }));
  }

  it("中ボタンドラッグで scrollLeft/scrollTop がドラッグ量ぶん動く", () => {
    const { getByTestId } = render(
      <TimelineViewport scenes={panScenes()} onSelectScene={vi.fn()} />,
    );
    const container = getByTestId("timeline-scroll-container");
    stubScroll(container, 0, 0);
    mouse(container, "mousedown", { button: 1, clientX: 500, clientY: 300 });
    // マウスを左上へ（dx=-50, dy=-20）→ コンテンツを掴んで動かす＝scroll は +50/+20。
    mouse(document, "mousemove", { button: 1, clientX: 450, clientY: 280 });
    expect(container.scrollLeft).toBe(50);
    expect(container.scrollTop).toBe(20);
    mouse(document, "mouseup", { button: 1, clientX: 450, clientY: 280 });
  });

  it("ドラッグ終了後の mousemove はパンしない（リスナ解除）", () => {
    const { getByTestId } = render(
      <TimelineViewport scenes={panScenes()} onSelectScene={vi.fn()} />,
    );
    const container = getByTestId("timeline-scroll-container");
    stubScroll(container, 0, 0);
    mouse(container, "mousedown", { button: 1, clientX: 500, clientY: 300 });
    mouse(document, "mousemove", { button: 1, clientX: 450, clientY: 300 });
    expect(container.scrollLeft).toBe(50);
    mouse(document, "mouseup", { button: 1, clientX: 450, clientY: 300 });
    // 解除後の move は無視される。
    mouse(document, "mousemove", { button: 1, clientX: 100, clientY: 300 });
    expect(container.scrollLeft).toBe(50);
  });

  it("左ボタンで背景をドラッグするとパンする（Chronicle と同挙動・閾値超え）", () => {
    const { getByTestId } = render(
      <TimelineViewport scenes={panScenes()} onSelectScene={vi.fn()} />,
    );
    const container = getByTestId("timeline-scroll-container");
    stubScroll(container, 0, 0);
    // 背景（コンテナ直下）を左ボタンでドラッグ = コンテンツを掴んで逆向きにスクロール。
    mouse(container, "mousedown", { button: 0, clientX: 500, clientY: 300 });
    mouse(document, "mousemove", { button: 0, clientX: 400, clientY: 250 });
    expect(container.scrollLeft).toBe(100);
    expect(container.scrollTop).toBe(50);
    mouse(document, "mouseup", { button: 0, clientX: 400, clientY: 250 });
  });

  it("左ボタンの閾値未満の動きではパンしない（クリック/選択を壊さない）", () => {
    const { getByTestId } = render(
      <TimelineViewport scenes={panScenes()} onSelectScene={vi.fn()} />,
    );
    const container = getByTestId("timeline-scroll-container");
    stubScroll(container, 0, 0);
    mouse(container, "mousedown", { button: 0, clientX: 500, clientY: 300 });
    // 3px 未満（THRESH=4）は pan 開始しない。
    mouse(document, "mousemove", { button: 0, clientX: 502, clientY: 301 });
    expect(container.scrollLeft).toBe(0);
    mouse(document, "mouseup", { button: 0, clientX: 502, clientY: 301 });
  });

  it("左ボタンでドット上をドラッグしても背景パンしない（シーンドラッグに委譲）", () => {
    const { container, getByTestId } = render(
      <TimelineViewport
        scenes={panScenes()}
        onSelectScene={vi.fn()}
        onDropStoryTime={vi.fn()}
      />,
    );
    const scroll = getByTestId("timeline-scroll-container");
    stubScroll(scroll, 0, 0);
    const dot = [...container.querySelectorAll("circle")].find((c) =>
      c.querySelector("title"),
    ) as SVGCircleElement;
    expect(dot).toBeTruthy();
    mouse(dot, "mousedown", { button: 0, clientX: 500, clientY: 200 });
    mouse(document, "mousemove", { button: 0, clientX: 400, clientY: 200 });
    // ドットの左ドラッグ = シーン並べ替え。背景パンは走らない（dragActiveRef ガード）。
    expect(scroll.scrollLeft).toBe(0);
    mouse(document, "mouseup", { button: 0, clientX: 400, clientY: 200 });
  });

  it("中ボタンをドット上で押してもシーンドラッグを起動せずパンする（button ガード）", () => {
    const onDrop = vi.fn();
    const { container, getByTestId } = render(
      <TimelineViewport
        scenes={panScenes()}
        onSelectScene={vi.fn()}
        onDropStoryTime={onDrop}
      />,
    );
    const scroll = getByTestId("timeline-scroll-container");
    stubScroll(scroll, 0, 0);
    // タイトル付き circle = シーンのドット（canDrag=true でドラッグ可能）。
    const dot = [...container.querySelectorAll("circle")].find((c) =>
      c.querySelector("title"),
    ) as SVGCircleElement;
    expect(dot).toBeTruthy();
    const cxBefore = dot.getAttribute("cx");
    mouse(dot, "mousedown", { button: 1, clientX: 500, clientY: 200 });
    mouse(document, "mousemove", { button: 1, clientX: 460, clientY: 200 });
    // ドラッグ未起動＝ドット位置(cx)は不変。パンだけ起きる。
    expect(dot.getAttribute("cx")).toBe(cxBefore);
    expect(scroll.scrollLeft).toBe(40);
    mouse(document, "mouseup", { button: 1, clientX: 460, clientY: 200 });
    expect(onDrop).not.toHaveBeenCalled(); // シーンの並べ替えは起きない
  });

  it("パン中に左ボタンを離してもパンは終了しない（中ボタン release のみで終了）", () => {
    const { getByTestId } = render(
      <TimelineViewport scenes={panScenes()} onSelectScene={vi.fn()} />,
    );
    const container = getByTestId("timeline-scroll-container");
    stubScroll(container, 0, 0);
    mouse(container, "mousedown", { button: 1, clientX: 500, clientY: 300 });
    mouse(document, "mouseup", { button: 0, clientX: 500, clientY: 300 }); // 左 release は無視
    mouse(document, "mousemove", { button: 1, clientX: 450, clientY: 300 });
    expect(container.scrollLeft).toBe(50); // パン継続中
    mouse(document, "mouseup", { button: 1, clientX: 450, clientY: 300 });
  });

  it("window blur でパンが中断する", () => {
    const { getByTestId } = render(
      <TimelineViewport scenes={panScenes()} onSelectScene={vi.fn()} />,
    );
    const container = getByTestId("timeline-scroll-container");
    stubScroll(container, 0, 0);
    mouse(container, "mousedown", { button: 1, clientX: 500, clientY: 300 });
    mouse(document, "mousemove", { button: 1, clientX: 470, clientY: 300 });
    expect(container.scrollLeft).toBe(30);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    // 中断後の move は無視される。
    mouse(document, "mousemove", { button: 1, clientX: 100, clientY: 300 });
    expect(container.scrollLeft).toBe(30);
  });

  it("パン中はコンテナに cursor-grabbing クラスが付き、終了で外れる", () => {
    const { getByTestId } = render(
      <TimelineViewport scenes={panScenes()} onSelectScene={vi.fn()} />,
    );
    const container = getByTestId("timeline-scroll-container");
    stubScroll(container, 0, 0);
    mouse(container, "mousedown", { button: 1, clientX: 500, clientY: 300 });
    expect(container.className).toContain("cursor-grabbing");
    mouse(document, "mouseup", { button: 1, clientX: 500, clientY: 300 });
    expect(container.className).not.toContain("cursor-grabbing");
  });

  it("mouseup でドキュメントの mousemove/mouseup(capture) リスナを解除する", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const { getByTestId } = render(
      <TimelineViewport scenes={panScenes()} onSelectScene={vi.fn()} />,
    );
    const container = getByTestId("timeline-scroll-container");
    stubScroll(container, 0, 0);
    mouse(container, "mousedown", { button: 1, clientX: 500, clientY: 300 });
    const moveFn = add.mock.calls.find(
      ([type, , opt]) => type === "mousemove" && opt === true,
    )?.[1];
    const upFn = add.mock.calls.find(
      ([type, , opt]) => type === "mouseup" && opt === true,
    )?.[1];
    expect(moveFn).toBeTruthy();
    expect(upFn).toBeTruthy();
    mouse(document, "mouseup", { button: 1, clientX: 500, clientY: 300 });
    expect(remove).toHaveBeenCalledWith("mousemove", moveFn, true);
    expect(remove).toHaveBeenCalledWith("mouseup", upFn, true);
    add.mockRestore();
    remove.mockRestore();
  });
});

describe("TimelineViewport – シーンドラッグ", () => {
  beforeEach(resetStore);

  const scenes = [
    { ...mockScene, id: "s1", storyTimeOrder: "a0" },
    { ...mockScene, id: "s2", storyTimeOrder: "a1" },
    { ...mockScene, id: "s3", storyTimeOrder: "a2" },
  ];

  it("高頻度 mousemove を1フレームへ集約し、React再描画なしで最新座標へ追従する", () => {
    setReduceMotion(true);
    let frame: FrameRequestCallback = () => {};
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const add = vi.spyOn(document, "addEventListener");
    try {
      const onDropStoryTime = vi.fn();
      let renderCount = 0;
      const { getByTestId } = render(
        <Profiler
          id="timeline-scene-drag"
          onRender={() => {
            renderCount += 1;
          }}
        >
          <TimelineViewport
            scenes={scenes}
            onSelectScene={vi.fn()}
            onDropStoryTime={onDropStoryTime}
          />
        </Profiler>,
      );
      const dot = getByTestId("timeline-scene-dot-s1");
      const svg = dot.closest("svg");
      expect(svg).not.toBeNull();
      const rectRead = vi.spyOn(svg!, "getBoundingClientRect");
      const rendersBeforeStart = renderCount;
      fireEvent.mouseDown(dot, { button: 0, clientX: 48, clientY: 60 });
      expect(rectRead).toHaveBeenCalledTimes(1);
      expect(renderCount).toBe(rendersBeforeStart);
      const rendersAfterStart = renderCount;
      const mainSvgAfterStart = svg!.outerHTML;
      const dragLayer = getByTestId("timeline-scene-drag-layer");
      expect(dragLayer.parentElement).toBe(
        getByTestId("timeline-viewport-frame"),
      );
      expect(dragLayer.parentElement).not.toBe(
        getByTestId("timeline-scroll-container"),
      );
      expect(dragLayer.style.contain).toBe("strict");
      expect(dragLayer.style.visibility).toBe("visible");
      expect(dragLayer).not.toBe(svg);
      // Keep the large static Timeline SVG paint-stable. The source dot stays
      // visible while the moving preview lives in its own bounded SVG layer.
      expect(dot.getAttribute("opacity")).toBeNull();
      const listenerAddsAfterStart = add.mock.calls.filter(
        ([type]) => type === "mousemove",
      ).length;
      startPerfSession();

      // Four raw samples collapse into one frame and only the latest is painted.
      fireEvent.mouseMove(document, { clientX: 180, clientY: 97 });
      fireEvent.mouseMove(document, { clientX: 181, clientY: 98 });
      fireEvent.mouseMove(document, { clientX: 182, clientY: 99 });
      fireEvent.mouseMove(document, { clientX: 183, clientY: 100 });
      expect(requestFrame).toHaveBeenCalledTimes(1);
      act(() => frame(0));
      // Once movement begins, the gesture owns a pre-armed frame clock. The
      // next pointer sample does not need to register a late rAF callback.
      expect(requestFrame).toHaveBeenCalledTimes(2);
      // The 5k-marker SVG remains byte-for-byte static. Only the isolated
      // preview layer receives a compositor transform / guide endpoint update.
      expect(dot.getAttribute("cx")).toBe("48");
      expect(dot.getAttribute("cy")).toBe("60");
      expect(svg!.outerHTML).toBe(mainSvgAfterStart);
      expect(getByTestId("timeline-scene-drag-marker").style.transform).toBe(
        "translate3d(177px, 94px, 0)",
      );
      const ghost = getByTestId("timeline-scene-drag-ghost");
      expect(ghost.parentElement).toBe(dragLayer);
      expect(ghost.style.transform).toContain("translate3d(48px, 60px, 0)");
      expect(ghost.style.transform).toContain("rotate(");
      expect(ghost.style.transform).toContain("scaleX(");
      expect(renderCount).toBe(rendersAfterStart);
      expect(
        add.mock.calls.filter(([type]) => type === "mousemove").length,
      ).toBe(listenerAddsAfterStart);

      // An input-free presentation frame remains part of the pre-armed clock,
      // but does not repeat DOM work. Sparse driver/input timing therefore
      // cannot be mistaken for a 32 ms rendered frame.
      act(() => frame(16));
      expect(requestFrame).toHaveBeenCalledTimes(3);
      expect(getByTestId("timeline-scene-drag-marker").style.transform).toBe(
        "translate3d(177px, 94px, 0)",
      );
      expect(svg!.outerHTML).toBe(mainSvgAfterStart);
      expect(renderCount).toBe(rendersAfterStart);

      // The next frame remains imperative and preserves the axis-lock behavior.
      fireEvent.mouseMove(document, { clientX: 184, clientY: 61 });
      act(() => frame(32));
      expect(requestFrame).toHaveBeenCalledTimes(4);
      expect(getByTestId("timeline-scene-drag-marker").style.transform).toBe(
        "translate3d(178px, 54px, 0)",
      );
      expect(ghost.style.transform).toContain("translate3d(48px, 60px, 0)");
      expect(ghost.style.transform).toContain("rotate(0rad)");
      expect(svg!.outerHTML).toBe(mainSvgAfterStart);
      // Pointer-frequency updates use the origin captured at mousedown rather
      // than forcing SVG layout after each geometry write.
      expect(rectRead).toHaveBeenCalledTimes(1);
      expect(renderCount).toBe(rendersAfterStart);
      const perfSession = endPerfSession();
      expect(perfSession?.counters["timeline.pointerFrame.work.count"]).toBe(2);
      expect(
        perfSession?.markStats.find(
          (entry) => entry.label === "timeline.pointerFrame.work",
        )?.count,
      ).toBe(2);
      expect(
        perfSession?.counters["timeline.pointerFrame.interval.count"],
      ).toBe(2);
      expect(
        perfSession?.markStats.find(
          (entry) => entry.label === "timeline.pointerFrame.interval",
        ),
      ).toMatchObject({ count: 2, maxMs: 16 });

      fireEvent.mouseUp(document, {
        button: 0,
        clientX: 200,
        clientY: 60,
      });
      expect(onDropStoryTime).toHaveBeenCalledWith("s1", "a1", "a2", false);
      expect(dragLayer.style.visibility).toBe("hidden");
    } finally {
      endPerfSession();
      add.mockRestore();
      vi.unstubAllGlobals();
      setReduceMotion(false);
    }
  });

  it("独立レイヤーは scroll/zoom 座標と active ring を保ち、元の hit target を維持する", () => {
    setReduceMotion(true);
    let frame: FrameRequestCallback = () => {};
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    useTreeStore.setState({ activeSceneId: "s2" });
    try {
      const { getByTestId, queryByTestId } = render(
        <TimelineViewport
          scenes={scenes}
          onSelectScene={vi.fn()}
          onDropStoryTime={vi.fn()}
        />,
      );
      const container = getByTestId("timeline-scroll-container");
      Object.defineProperty(container, "scrollLeft", {
        configurable: true,
        writable: true,
        value: 40,
      });
      Object.defineProperty(container, "scrollTop", {
        configurable: true,
        writable: true,
        value: 0,
      });
      const dot = getByTestId("timeline-scene-dot-s2");
      const svg = getByTestId("timeline-main-svg");
      vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
        x: -40,
        y: 0,
        left: -40,
        top: 0,
        right: 328,
        bottom: 130,
        width: 368,
        height: 130,
        toJSON: () => ({}),
      });

      // s2 is x=144 at zoom=1; with scrollLeft=40 it is at clientX=104.
      fireEvent.mouseDown(dot, { button: 0, clientX: 104, clientY: 60 });
      const dragLayer = getByTestId("timeline-scene-drag-layer");
      expect(dragLayer.style.visibility).toBe("visible");
      expect(dragLayer.style.left).toBe("");
      expect(
        queryByTestId("timeline-scene-drag-active-ring")?.style.display,
      ).toBe("");

      // Scrolling by +20 while dragging must be included in content coordinates.
      container.scrollLeft = 60;
      fireEvent.mouseMove(document, { clientX: 128, clientY: 100 });
      act(() => frame(0));
      expect(getByTestId("timeline-scene-drag-marker").style.transform).toBe(
        "translate3d(122px, 94px, 0)",
      );

      // Zoom moves the scene anchor from x=144 to x=240. The preview offset is
      // recomputed in layout so its screen position remains at the pointer.
      act(() => useTimelineStore.setState({ zoom: 2 }));
      expect(getByTestId("timeline-scene-drag-marker").style.transform).toBe(
        "translate3d(122px, 94px, 0)",
      );
      expect(
        getByTestId("timeline-scene-drag-ghost").style.transform,
      ).toContain("translate3d(180px, 60px, 0)");

      fireEvent.blur(window);
      expect(dragLayer.style.visibility).toBe("hidden");
      expect(dot.getAttribute("opacity")).toBeNull();
      // The original interactive circle was never replaced by the overlay.
      expect(getByTestId("timeline-scene-dot-s2")).toBe(dot);
    } finally {
      vi.unstubAllGlobals();
      setReduceMotion(false);
    }
  });

  it("keepalive-hidden 遷移でシーンドラッグの rAF と document listener を取消す", () => {
    setReduceMotion(true);
    let nextFrameId = 0;
    const requestFrame = vi.fn(() => {
      nextFrameId += 1;
      return nextFrameId;
    });
    const cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    const onDropStoryTime = vi.fn();
    try {
      const { getByTestId, rerender } = render(
        <TimelineViewport
          scenes={scenes}
          onSelectScene={vi.fn()}
          onDropStoryTime={onDropStoryTime}
          isActive
        />,
      );
      fireEvent.mouseDown(getByTestId("timeline-scene-dot-s1"), {
        button: 0,
        clientX: 48,
        clientY: 60,
      });
      fireEvent.mouseMove(document, { clientX: 180, clientY: 90 });
      expect(requestFrame).toHaveBeenCalledTimes(1);
      expect(getByTestId("timeline-scene-drag-layer").style.visibility).toBe(
        "visible",
      );

      rerender(
        <TimelineViewport
          scenes={scenes}
          onSelectScene={vi.fn()}
          onDropStoryTime={onDropStoryTime}
          isActive={false}
        />,
      );
      expect(cancelFrame).toHaveBeenCalledWith(1);
      expect(getByTestId("timeline-scene-drag-layer").style.visibility).toBe(
        "hidden",
      );
      fireEvent.mouseUp(document, {
        button: 0,
        clientX: 180,
        clientY: 90,
      });
      expect(onDropStoryTime).not.toHaveBeenCalled();

      fireEvent.mouseDown(getByTestId("timeline-scene-dot-s1"), {
        button: 0,
        clientX: 48,
        clientY: 60,
      });
      fireEvent.mouseMove(document, { clientX: 200, clientY: 90 });
      expect(requestFrame).toHaveBeenCalledTimes(1);
      expect(getByTestId("timeline-scene-drag-layer").style.visibility).toBe(
        "hidden",
      );
    } finally {
      vi.unstubAllGlobals();
      setReduceMotion(false);
    }
  });

  it("window blur で保留中のシーンドラッグを取消し、復帰後は再度ドロップできる", () => {
    const onDropStoryTime = vi.fn();
    const { getByTestId } = render(
      <TimelineViewport
        scenes={scenes}
        onSelectScene={vi.fn()}
        onDropStoryTime={onDropStoryTime}
      />,
    );
    const dot = getByTestId("timeline-scene-dot-s1");
    fireEvent.mouseDown(dot, { button: 0, clientX: 48, clientY: 60 });
    fireEvent.mouseMove(document, { clientX: 200, clientY: 100 });
    fireEvent.blur(window);
    expect(getByTestId("timeline-scene-drag-layer").style.visibility).toBe(
      "hidden",
    );
    fireEvent.mouseUp(document, {
      button: 0,
      clientX: 200,
      clientY: 100,
    });
    expect(onDropStoryTime).not.toHaveBeenCalled();

    fireEvent.mouseDown(dot, { button: 0, clientX: 48, clientY: 60 });
    fireEvent.mouseUp(document, {
      button: 0,
      clientX: 200,
      clientY: 60,
    });
    expect(onDropStoryTime).toHaveBeenCalledWith("s1", "a1", "a2", false);
  });
});

describe("TimelineViewport – シーン縦グリッド（threads モード）", () => {
  beforeEach(resetStore);

  it("threads モードでシーン数ぶんの縦グリッドを描く", () => {
    useTimelineStore.setState({ showThreads: true });
    const scenes = [
      { ...mockScene, id: "s1" },
      { ...mockScene, id: "s2" },
      { ...mockScene, id: "s3" },
    ];
    const { container } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    expect(
      container.querySelectorAll('[data-testid="scene-gridline"]').length,
    ).toBe(3);
  });

  it("scenes モードでは縦グリッドを描かない", () => {
    useTimelineStore.setState({ showThreads: false });
    const { container } = render(
      <TimelineViewport scenes={[mockScene]} onSelectScene={vi.fn()} />,
    );
    expect(
      container.querySelectorAll('[data-testid="scene-gridline"]').length,
    ).toBe(0);
  });
});

describe("TimelineViewport – スレッド線と収束（threads オーバーレイ）", () => {
  beforeEach(resetStore);

  const scenes = [
    { ...mockScene, id: "s1" },
    { ...mockScene, id: "s2" },
    { ...mockScene, id: "s3" },
  ];

  function seedThreads() {
    usePlotThreadStore.setState({
      threads: [
        {
          id: "t1",
          projectId: "p",
          name: "T1",
          color: null,
          description: null,
          sortOrder: "a0",
          startNodeId: null,
          endNodeId: null,
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "t2",
          projectId: "p",
          name: "T2",
          color: null,
          description: null,
          sortOrder: "a1",
          startNodeId: null,
          endNodeId: null,
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      links: [
        {
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
        },
        {
          id: "l2",
          threadId: "t1",
          nodeId: "s3",
          phaseType: "climax",
          note: null,
          sortOrder: null,
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "l3",
          threadId: "t2",
          nodeId: "s3",
          phaseType: "introduce",
          note: null,
          sortOrder: null,
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
    });
  }

  it("reading-order では >=2 マーカーのスレッド線を引く", () => {
    seedThreads();
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
    const { container } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    expect(
      container.querySelector('[data-testid^="plot-thread-line-t1"]'),
    ).toBeTruthy();
  });

  it("story-time ではスレッド線を引かない（マーカーのみ）", () => {
    seedThreads();
    useTimelineStore.setState({ showThreads: true, axisMode: "story" });
    const { container } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    expect(
      container.querySelector('[data-testid^="plot-thread-line-t1"]'),
    ).toBeNull();
  });

  it("収束列（2 本以上が通るシーン）に縦バンドを描く", () => {
    seedThreads();
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
    const { container } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    // s3 で t1,t2 が収束 → バンド 1 本
    expect(
      container.querySelectorAll('[data-testid="thread-convergence"]').length,
    ).toBe(1);
  });

  function seedBranch() {
    usePlotThreadStore.setState({
      branches: [
        {
          id: "br1",
          projectId: "p",
          fromThreadId: "t1",
          toThreadId: "t2",
          atNodeId: "s2",
          kind: "branch",
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
  }

  it("reading-order では分岐コネクタを描く", () => {
    seedThreads();
    seedBranch();
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
    const { container } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    expect(
      container.querySelectorAll('[data-testid="plot-thread-connector"]')
        .length,
    ).toBe(1);
  });

  it("story-time では分岐コネクタを描かない", () => {
    seedThreads();
    seedBranch();
    useTimelineStore.setState({ showThreads: true, axisMode: "story" });
    const { container } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    expect(
      container.querySelectorAll('[data-testid="plot-thread-connector"]')
        .length,
    ).toBe(0);
  });

  it("コネクタは通常の帯と同じ太さ・破線なしで描く（branch / merge とも）", () => {
    seedThreads(); // t1: l1@s1, l2@s3 → 帯セグメントあり
    usePlotThreadStore.setState({
      branches: [
        {
          id: "br1",
          projectId: "p",
          fromThreadId: "t1",
          toThreadId: "t2",
          atNodeId: "s2",
          kind: "branch",
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "mg1",
          projectId: "p",
          fromThreadId: "t2",
          toThreadId: "t1",
          atNodeId: "s3",
          kind: "merge",
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
    const { container } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    // 通常の帯（スレッド線）の太さを基準にする。
    const band = container.querySelector('[data-testid^="plot-thread-line-"]');
    const bandWidth = band?.getAttribute("stroke-width");
    expect(bandWidth).toBeTruthy();
    // 帯は不透過（重なり混色を避ける）。strokeOpacity を指定しない（既定=1）。
    expect(band?.getAttribute("stroke-opacity")).toBeNull();
    const conns = container.querySelectorAll(
      '[data-testid="plot-thread-connector"]',
    );
    expect(conns.length).toBe(2);
    for (const c of conns) {
      // 通常の線と同じ太さ・不透過・破線なし（種別はランプ方向で表す）。
      expect(c.getAttribute("stroke-width")).toBe(bandWidth);
      expect(c.getAttribute("stroke-dasharray")).toBeNull();
      expect(c.getAttribute("stroke-opacity")).toBeNull();
    }
  });

  it("マーカーはスレッド線（帯・コネクタ）より後＝前面に描画される", () => {
    seedThreads(); // t1: l1@s1, l2@s3
    seedBranch(); // branch t1→t2 @s2（コネクタ 1 本）
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
    const { container } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    // SVG は document 順 = 描画順。マーカーが帯・コネクタより後ろにあれば前面。
    const els = Array.from(container.querySelectorAll("svg *"));
    const idxOf = (pred: (el: Element) => boolean) => els.findIndex(pred);
    const bandIdx = idxOf((el) =>
      (el.getAttribute("data-testid") ?? "").startsWith("plot-thread-line-"),
    );
    const connIdx = idxOf(
      (el) => el.getAttribute("data-testid") === "plot-thread-connector",
    );
    const markerIdx = idxOf((el) =>
      (el.getAttribute("data-testid") ?? "").startsWith("plot-marker-"),
    );
    expect(bandIdx).toBeGreaterThanOrEqual(0);
    expect(connIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBeGreaterThan(bandIdx);
    expect(markerIdx).toBeGreaterThan(connIdx);
  });

  function seedMergeBranch() {
    usePlotThreadStore.setState({
      branches: [
        {
          id: "mg1",
          projectId: "p",
          fromThreadId: "t2",
          toThreadId: "t1",
          atNodeId: "s3", // t1@s3 = l2 が merge の流入先
          kind: "merge",
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
  }

  it("縮小時、merge の流入先マーカーは subway 風の白丸ドーナツで描く", () => {
    seedThreads(); // t1: l1@s1, l2@s3
    seedMergeBranch();
    useTimelineStore.setState({
      showThreads: true,
      axisMode: "reading",
      zoom: 0.5, // STEP=48 < CHIP_MIN_STEP(72) → 縮小表示
    });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    // 流入先(l2)は白丸ドーナツ（circle・白塗り・data-merge-target）。
    const merge = getByTestId("plot-marker-l2");
    expect(merge.tagName.toLowerCase()).toBe("circle");
    expect(merge.getAttribute("data-merge-target")).toBe("true");
    expect(merge.getAttribute("fill")).toContain("background");
    // 非 merge マーカー(l1)は通常描画（ドーナツでない）。
    expect(
      getByTestId("plot-marker-l1").getAttribute("data-merge-target"),
    ).toBeNull();
  });

  it("拡大時、merge の流入先マーカーは白抜きチップで段階テキストを表示する", () => {
    seedThreads(); // t1: l1@s1, l2@s3（l2 = climax, color=null → var(--primary)）
    seedMergeBranch();
    useTimelineStore.setState({
      showThreads: true,
      axisMode: "reading",
      zoom: 1, // STEP=96 >= CHIP_MIN_STEP(72) → 拡大表示
    });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    // 拡大時はドーナツ(circle)でなくチップ(<g>+rect+text)。段階ラベルが見える。
    const merge = getByTestId("plot-marker-l2");
    expect(merge.tagName.toLowerCase()).toBe("g");
    expect(merge.getAttribute("data-merge-target")).toBe("true");
    expect(merge.textContent).toContain("クライマックス");
    // 白抜き: 背景塗り＋スレッド色リング＋色文字。
    const rect = merge.querySelector("rect");
    expect(rect?.getAttribute("fill")).toContain("background");
    expect(rect?.getAttribute("stroke")).toBe("var(--primary)");
    expect(merge.querySelector("text")?.getAttribute("fill")).toBe(
      "var(--primary)",
    );
    // 対照: 非 merge チップ(l1)は塗りつぶし（背景塗りでない）。
    const plain = getByTestId("plot-marker-l1").querySelector("rect");
    expect(plain?.getAttribute("fill")).not.toContain("background");
  });

  it("拡大時、from列にチップがあるとランプ根本をチップ左へ逃がす", () => {
    seedThreads(); // t1: l1@s1(introduce), l2@s3(climax) / t2: l3@s3
    usePlotThreadStore.setState({
      branches: [
        {
          id: "br-s3",
          projectId: "p",
          fromThreadId: "t1", // from(t1) は s3 に climax チップ(l2)を持つ
          toThreadId: "t2",
          atNodeId: "s3",
          kind: "branch",
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    useTimelineStore.setState({
      showThreads: true,
      axisMode: "reading",
      zoom: 1, // STEP=96 >= CHIP_MIN_STEP(72) → チップ表示
    });
    const { getByTestId, container } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    // from チップ(l2)の左端 x。
    const rect = getByTestId("plot-marker-l2").querySelector("rect");
    const chipLeft = parseFloat(rect?.getAttribute("x") ?? "NaN");
    // コネクタ path 始点 x（= ランプ根本）。"M <x> <y> C ..."
    const conn = container.querySelector(
      '[data-testid="plot-thread-connector"]',
    );
    const startX = parseFloat((conn?.getAttribute("d") ?? "").split(" ")[1]);
    // 根本がチップ左端より左に出る（旧実装の X-RAMP はチップ下に隠れていた）。
    expect(Number.isNaN(startX)).toBe(false);
    expect(startX).toBeLessThan(chipLeft);
  });

  it("拡大時、ランプの逃がし量（余白）は倍率に応じて大きくなる", () => {
    // 余白 = chipLeft - startX = chipW/2 は一定なので、X に依らず CONNECTOR_RAMP_MARGIN*zoom。
    const gapAt = (zoom: number) => {
      seedThreads();
      usePlotThreadStore.setState({
        branches: [
          {
            id: "br-s3",
            projectId: "p",
            fromThreadId: "t1",
            toThreadId: "t2",
            atNodeId: "s3",
            kind: "branch",
            semanticKey: "",
            version: 0,
            createdAt: "",
            updatedAt: "",
          },
        ],
      });
      useTimelineStore.setState({
        showThreads: true,
        axisMode: "reading",
        zoom,
      });
      const { getByTestId, container, unmount } = render(
        <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
      );
      const chipLeft = parseFloat(
        getByTestId("plot-marker-l2")
          .querySelector("rect")
          ?.getAttribute("x") ?? "NaN",
      );
      const startX = parseFloat(
        (
          container
            .querySelector('[data-testid="plot-thread-connector"]')
            ?.getAttribute("d") ?? ""
        ).split(" ")[1],
      );
      unmount();
      return chipLeft - startX;
    };
    const gap1 = gapAt(1);
    const gap2 = gapAt(2);
    expect(gap1).toBeGreaterThan(0);
    // 倍率2倍で余白も約2倍（chipW/2 は一定、CONNECTOR_RAMP_MARGIN*zoom 部分が伸びる）。
    expect(gap2).toBeGreaterThan(gap1 * 1.5);
  });

  it("自走完結スレッドに終端キャップ（塗りノブ）を描く", () => {
    seedThreads(); // t1: l1@s1, l2@s3（最後 s3 は merge でない）→ 終端あり
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
    const { container } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    expect(
      container.querySelector('[data-testid="plot-thread-terminus-t1"]'),
    ).toBeTruthy();
  });

  it("story-time では終端キャップを描かない", () => {
    seedThreads();
    useTimelineStore.setState({ showThreads: true, axisMode: "story" });
    const { container } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    expect(
      container.querySelector('[data-testid="plot-thread-terminus-t1"]'),
    ).toBeNull();
  });

  it("マーカーチップに段階テキストを表示する", () => {
    seedThreads();
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    // l1 は introduce → JA ラベル「セットアップ」がチップ内に出る
    expect(getByTestId("plot-marker-l1").textContent).toContain("セットアップ");
  });

  it("縮小時(zoom 小)はチップでなく円に縮退する", () => {
    seedThreads();
    useTimelineStore.setState({
      showThreads: true,
      axisMode: "reading",
      zoom: 0.5, // STEP=48 < CHIP_MIN_STEP(72)
    });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const m = getByTestId("plot-marker-l1");
    // 円に縮退（チップの rect/可視テキストは無い。ラベルは title ツールチップのみ）。
    expect(m.tagName.toLowerCase()).toBe("circle");
    expect(m.querySelector("rect")).toBeNull();
  });

  it("選択中マーカーはチップに選択リングが付く", () => {
    seedThreads();
    useTimelineStore.setState({
      showThreads: true,
      axisMode: "reading",
      selectedPlotLinkId: "l1",
    });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const rect = getByTestId("plot-marker-l1").querySelector("rect");
    expect(rect?.getAttribute("stroke")).toBe("var(--foreground)");
  });

  it("スレッドエリアは縦スクロール可能（overflow-y-auto）", () => {
    seedThreads();
    useTimelineStore.setState({ showThreads: true });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    expect(getByTestId("timeline-scroll-container").className).toContain(
      "overflow-y-auto",
    );
  });
});

describe("TimelineViewport – マーカー DnD（Model A: ドロップ先で判定）", () => {
  beforeEach(resetStore);

  const scenes = [
    { ...mockScene, id: "s1" },
    { ...mockScene, id: "s2" },
  ];
  const t = (id: string, sortOrder: string) => ({
    id,
    projectId: "p",
    name: id,
    color: null,
    description: null,
    sortOrder,
    startNodeId: null,
    endNodeId: null,
    version: 0,
    createdAt: "",
    updatedAt: "",
  });
  const l = (id: string, threadId: string, nodeId: string) => ({
    id,
    threadId,
    nodeId,
    phaseType: "introduce" as const,
    note: null,
    sortOrder: null,
    semanticKey: `${threadId}|${nodeId}|introduce`,
    version: 0,
    createdAt: "",
    updatedAt: "",
  });
  // threadsTop = SVG_HEIGHT_BASE(130) + LANE_HEIGHT/2(28) = 158 → lane0.y=158, lane1.y=214
  // s1 x = 150, s2 x = 246（STEP=96, padLeft=SUBWAY_LABEL_GUTTER=150）
  function seed() {
    usePlotThreadStore.setState({
      threads: [t("t1", "a0"), t("t2", "a1")],
      links: [l("l1", "t1", "s1"), l("l2", "t2", "s1")],
      branches: [],
      loading: false,
    });
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
  }

  it("同レーンで横ドラッグ → atomic bundle でシーン移動", () => {
    seed();
    const moveMarkerBundle = vi.fn(async () => {});
    usePlotThreadStore.setState({ moveMarkerBundle });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const m = getByTestId("plot-marker-l1");
    fireEvent.mouseDown(m, { clientX: 150, clientY: 158 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 158 });
    fireEvent.mouseUp(document, { clientX: 246, clientY: 158 });
    expect(moveMarkerBundle).toHaveBeenCalledWith({
      markerId: "l1",
      markerPatch: { nodeId: "s2" },
    });
  });

  it("マーカードラッグ中はグラフを再計算しプレビューのコネクタが出る（確定前）", async () => {
    seed();
    usePlotThreadStore.setState({
      moveMarkerBundle: vi.fn(async () => {}),
      addMarker: vi.fn(),
    });
    const { getByTestId, container } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const conns = () =>
      container.querySelectorAll('[data-testid="plot-thread-connector"]')
        .length;
    expect(conns()).toBe(0); // 初期はエッジ無し
    const m = getByTestId("plot-marker-l1"); // t1(上,y158)@s1
    // t2(下,y214) の s2(x246) へドラッグ → branch。mouseup 前にコネクタが出る。
    fireEvent.mouseDown(m, { clientX: 150, clientY: 158 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 214 });
    await waitFor(() => expect(conns()).toBeGreaterThan(0)); // rAF後にライブ再計算
    fireEvent.mouseUp(document, { clientX: 246, clientY: 214 });
  });

  it("下のレーンへドラッグ → branch: ドラッグ点を先(to)へ移動・元に点は作らない", () => {
    seed();
    const moveMarkerBundle = vi.fn(async () => {});
    const addMarker = vi.fn();
    usePlotThreadStore.setState({ moveMarkerBundle, addMarker });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const m = getByTestId("plot-marker-l1"); // t1(上)@s1
    // t2(下, y214) の s2(x144) へ → branch。点は t2 へ移動、元 t1 には作らない。
    fireEvent.mouseDown(m, { clientX: 150, clientY: 158 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 214 });
    fireEvent.mouseUp(document, { clientX: 246, clientY: 214 });
    expect(moveMarkerBundle).toHaveBeenCalledWith({
      markerId: "l1",
      markerPatch: {
        threadId: "t2",
        nodeId: "s2",
      },
      branchCreates: [
        {
          fromThreadId: "t1",
          toThreadId: "t2",
          atNodeId: "s2",
          kind: "branch",
        },
      ],
    });
    expect(addMarker).not.toHaveBeenCalled(); // 第2の点は作らない
  });

  it("上のレーンへドラッグ → merge: ドラッグ点を移動先(to)へ移す・元に点は作らない", () => {
    seed();
    const moveMarkerBundle = vi.fn(async () => {});
    const addMarker = vi.fn();
    usePlotThreadStore.setState({ moveMarkerBundle, addMarker });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const m = getByTestId("plot-marker-l2"); // t2(下)@s1
    // t1(上, y158) の s2(x144) へ → merge。統一モデルで点は移動先 to=t1 へ移す。元 t2 には残さない。
    fireEvent.mouseDown(m, { clientX: 150, clientY: 214 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 158 });
    fireEvent.mouseUp(document, { clientX: 246, clientY: 158 });
    expect(moveMarkerBundle).toHaveBeenCalledWith({
      markerId: "l2",
      markerPatch: {
        threadId: "t1",
        nodeId: "s2",
      },
      branchCreates: [
        {
          fromThreadId: "t2",
          toThreadId: "t1",
          atNodeId: "s2",
          kind: "merge",
        },
      ],
    });
    expect(addMarker).not.toHaveBeenCalled();
  });

  it("動かさず mousedown→mouseup なら選択（マーカー＋そのシーン）", () => {
    seed();
    const onSelectMarker = vi.fn();
    const onSelectScene = vi.fn();
    const { getByTestId } = render(
      <TimelineViewport
        scenes={scenes}
        onSelectScene={onSelectScene}
        onSelectMarker={onSelectMarker}
      />,
    );
    const m = getByTestId("plot-marker-l1"); // l1 = t1@s1
    fireEvent.mouseDown(m, { clientX: 150, clientY: 158 });
    fireEvent.mouseUp(document, { clientX: 150, clientY: 158 });
    expect(onSelectMarker).toHaveBeenCalledWith("l1");
    // subway と同じくマーカーが乗るシーンも選択する。
    expect(onSelectScene).toHaveBeenCalledWith("s1");
  });

  it("既存と同一の分岐になるドロップは source を動かさない（非アトミック防止）", () => {
    usePlotThreadStore.setState({
      threads: [t("t1", "a0"), t("t2", "a1")],
      links: [l("l1", "t1", "s2"), l("l2", "t2", "s2")],
      branches: [
        {
          id: "br1",
          projectId: "p",
          fromThreadId: "t1",
          toThreadId: "t2",
          atNodeId: "s2",
          kind: "branch",
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
    });
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
    const moveMarkerBundle = vi.fn(async () => {});
    const addMarker = vi.fn();
    usePlotThreadStore.setState({ moveMarkerBundle, addMarker });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    // l1 = t1@s2(x144,y158) を t2 レーン(y214) の s2(x144) へ → 同一エッジで dup
    const m = getByTestId("plot-marker-l1");
    fireEvent.mouseDown(m, { clientX: 246, clientY: 158 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 214 });
    fireEvent.mouseUp(document, { clientX: 246, clientY: 214 });
    // dup なので何も起きない（source も動かない）
    expect(moveMarkerBundle).not.toHaveBeenCalled();
    expect(addMarker).not.toHaveBeenCalled();
  });

  it("同じドロップ先への mousemove ではレーンモデルを再構築しない（離散キーで抑制）", () => {
    setReduceMotion(true);
    let frame: FrameRequestCallback = () => {};
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    try {
      seed();
      usePlotThreadStore.setState({
        moveMarkerBundle: vi.fn(async () => {}),
        addMarker: vi.fn(),
      });
      const spy = vi.mocked(buildPlotLaneModel);
      let renderCount = 0;
      const { getByTestId } = render(
        <Profiler
          id="timeline-marker-drag"
          onRender={() => {
            renderCount += 1;
          }}
        >
          <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />
        </Profiler>,
      );
      const m = getByTestId("plot-marker-l1"); // t1(上,y158)@s1
      fireEvent.mouseDown(m, { clientX: 150, clientY: 158 });
      // Four raw samples in one frame collapse to one drop resolution/render.
      fireEvent.mouseMove(document, { clientX: 246, clientY: 214 });
      fireEvent.mouseMove(document, { clientX: 247, clientY: 215 });
      fireEvent.mouseMove(document, { clientX: 244, clientY: 213 });
      fireEvent.mouseMove(document, { clientX: 248, clientY: 214 });
      expect(requestFrame).toHaveBeenCalledTimes(1);
      act(() => frame(0));
      const afterFirst = spy.mock.calls.length;
      const rendersAfterFirst = renderCount;
      expect(getByTestId("plot-marker-ghost").getAttribute("cx")).toBe("248");
      expect(getByTestId("plot-marker-ghost").getAttribute("cy")).toBe("214");

      // The same discrete destination in the next frame only moves the ghost.
      fireEvent.mouseMove(document, { clientX: 247, clientY: 213 });
      act(() => frame(16));
      expect(spy.mock.calls.length).toBe(afterFirst);
      expect(renderCount).toBe(rendersAfterFirst);

      // ドロップ先（列）が変われば再構築される（プレビューは追従したまま）。
      fireEvent.mouseMove(document, { clientX: 150, clientY: 214 });
      act(() => frame(32));
      expect(spy.mock.calls.length).toBeGreaterThan(afterFirst);
      fireEvent.mouseUp(document, { clientX: 150, clientY: 214 });
    } finally {
      vi.unstubAllGlobals();
      setReduceMotion(false);
    }
  });

  it("window blur は保留中のマーカードラッグを取消し、復帰後のクリックを妨げない", () => {
    seed();
    const moveMarkerBundle = vi.fn(async () => {});
    const onSelectMarker = vi.fn();
    usePlotThreadStore.setState({ moveMarkerBundle });
    const { getByTestId } = render(
      <TimelineViewport
        scenes={scenes}
        onSelectScene={vi.fn()}
        onSelectMarker={onSelectMarker}
      />,
    );
    const marker = getByTestId("plot-marker-l1");
    fireEvent.mouseDown(marker, { clientX: 150, clientY: 158 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 214 });
    fireEvent.blur(window);
    fireEvent.mouseUp(document, { button: 0, clientX: 246, clientY: 214 });
    expect(moveMarkerBundle).not.toHaveBeenCalled();

    fireEvent.mouseDown(marker, { clientX: 150, clientY: 158 });
    fireEvent.mouseUp(document, { button: 0, clientX: 150, clientY: 158 });
    expect(onSelectMarker).toHaveBeenCalledWith("l1");
  });
});

describe("TimelineViewport – ヘッダー縦ドラッグ並べ替え（#8, X固定）", () => {
  beforeEach(resetStore);

  const scenes = [
    { ...mockScene, id: "s1" },
    { ...mockScene, id: "s2" },
  ];
  const th = (id: string, so: string) => ({
    id,
    projectId: "p",
    name: id,
    color: null,
    description: null,
    sortOrder: so,
    startNodeId: null,
    endNodeId: null,
    version: 0,
    createdAt: "",
    updatedAt: "",
  });
  const lk = (id: string, threadId: string, nodeId: string) => ({
    id,
    threadId,
    nodeId,
    phaseType: "introduce" as const,
    note: null,
    sortOrder: null,
    semanticKey: "",
    version: 0,
    createdAt: "",
    updatedAt: "",
  });
  // lane0=158, lane1=214（threadsTop=158, LANE_HEIGHT=56）
  function seed() {
    usePlotThreadStore.setState({
      threads: [th("t1", "a0"), th("t2", "a1")],
      links: [lk("l1", "t1", "s1"), lk("l2", "t2", "s1")],
      branches: [],
      loading: false,
    });
    useTimelineStore.setState({
      showThreads: true,
      axisMode: "reading",
      plotSubwaySort: false,
    });
  }

  it("ヘッダーを下の行へドラッグ → reorderThread で a1 より後ろのキーに並べ替え", () => {
    seed();
    const reorderThread = vi.fn();
    usePlotThreadStore.setState({ reorderThread });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const label = getByTestId("plot-lane-label-t1");
    // y158(行0) から y214(行1) へドラッグ。
    fireEvent.mouseDown(label, { clientX: 70, clientY: 158 });
    fireEvent.mouseMove(document, { clientX: 70, clientY: 214 });
    fireEvent.mouseUp(document, { clientX: 70, clientY: 214 });
    expect(reorderThread).toHaveBeenCalledTimes(1);
    const [id, key] = reorderThread.mock.calls[0];
    expect(id).toBe("t1");
    // t2(a1) より後ろへ＝キーは a1 より大きい。
    expect(cmpKeys(key, "a1")).toBeGreaterThan(0);
  });

  it("ドラッグ中はラベルとグラフが一緒にカーソル Y へ即時追従する（X固定）", () => {
    setReduceMotion(true);
    let frame: FrameRequestCallback = () => {};
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    try {
      seed();
      usePlotThreadStore.setState({ reorderThread: vi.fn() });
      let renderCount = 0;
      const { getByTestId } = render(
        <Profiler
          id="timeline-label-drag"
          onRender={() => {
            renderCount += 1;
          }}
        >
          <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />
        </Profiler>,
      );
      const l1 = getByTestId("plot-lane-label-t1");
      // One frame consumes only the latest of three pointer samples.
      fireEvent.mouseDown(l1, { clientX: 70, clientY: 158 });
      fireEvent.mouseMove(document, { clientX: 70, clientY: 200 });
      fireEvent.mouseMove(document, { clientX: 70, clientY: 202 });
      fireEvent.mouseMove(document, { clientX: 70, clientY: 203 });
      expect(requestFrame).toHaveBeenCalledTimes(1);
      act(() => frame(0));
      const rendersAfterFirst = renderCount;
      fireEvent.mouseMove(document, { clientX: 70, clientY: 204 });
      act(() => frame(16));
      expect(renderCount).toBe(rendersAfterFirst);
      // topology 座標は不変のまま、ラベル/グラフ双方の group transform が同じ
      // display Y を与える（rAF で React 全体を render しない）。
      const labelGroup = getByTestId("plot-lane-label-t1");
      const circle = labelGroup.querySelector("circle");
      expect(
        Number(circle?.getAttribute("cy")) + svgTranslateY(labelGroup),
      ).toBe(204);
      const hit = getByTestId("plot-lane-hit-t1");
      const laneGroup = hit.closest("[data-lane-transform-id]")!;
      expect(Number(hit.getAttribute("y")) + svgTranslateY(laneGroup)).toBe(
        176,
      );
      fireEvent.mouseUp(document, { clientX: 70, clientY: 204 });
    } finally {
      vi.unstubAllGlobals();
      setReduceMotion(false);
    }
  });

  it("ドラッグ点を列の外（下端より下）へ動かしても帯内にクランプされ見切れない", async () => {
    seed();
    usePlotThreadStore.setState({ reorderThread: vi.fn() });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const l1 = getByTestId("plot-lane-label-t1");
    // 2スレッドの最終行 Y = 158 + 56 = 214。はるか下(2000)へドラッグ。
    fireEvent.mouseDown(l1, { clientX: 70, clientY: 158 });
    fireEvent.mouseMove(document, { clientX: 70, clientY: 2000 });
    const labelGroup = getByTestId("plot-lane-label-t1");
    await waitFor(() => {
      const cy =
        Number(labelGroup.querySelector("circle")?.getAttribute("cy")) +
        svgTranslateY(labelGroup);
      expect(cy).toBe(214); // 最終行へクランプ（2000 まで追従しない）
    });
    fireEvent.mouseUp(document, { clientX: 70, clientY: 2000 });
  });

  it("window blur は保留中のヘッダードラッグを取消し、復帰後の選択を妨げない", () => {
    seed();
    const reorderThread = vi.fn();
    const onSelectThread = vi.fn();
    usePlotThreadStore.setState({ reorderThread });
    const { getByTestId } = render(
      <TimelineViewport
        scenes={scenes}
        onSelectScene={vi.fn()}
        onSelectThread={onSelectThread}
      />,
    );
    const label = getByTestId("plot-lane-label-t1");
    fireEvent.mouseDown(label, { clientX: 70, clientY: 158 });
    fireEvent.mouseMove(document, { clientX: 70, clientY: 214 });
    fireEvent.blur(window);
    fireEvent.mouseUp(document, { button: 0, clientX: 70, clientY: 214 });
    expect(reorderThread).not.toHaveBeenCalled();

    fireEvent.mouseDown(label, { clientX: 70, clientY: 158 });
    fireEvent.mouseUp(document, { button: 0, clientX: 70, clientY: 158 });
    expect(onSelectThread).toHaveBeenCalledWith("t1");
  });

  it("動かさず mousedown→mouseup なら選択（並べ替えしない）", () => {
    seed();
    const reorderThread = vi.fn();
    const onSelectThread = vi.fn();
    usePlotThreadStore.setState({ reorderThread });
    const { getByTestId } = render(
      <TimelineViewport
        scenes={scenes}
        onSelectScene={vi.fn()}
        onSelectThread={onSelectThread}
      />,
    );
    const label = getByTestId("plot-lane-label-t1");
    fireEvent.mouseDown(label, { clientX: 70, clientY: 158 });
    fireEvent.mouseUp(document, { clientX: 70, clientY: 158 });
    expect(onSelectThread).toHaveBeenCalledWith("t1");
    expect(reorderThread).not.toHaveBeenCalled();
  });

  it("subwaySort ON のときはドラッグしても並べ替えない＋カーソル追従もしない", () => {
    seed();
    useTimelineStore.setState({ plotSubwaySort: true });
    const reorderThread = vi.fn();
    usePlotThreadStore.setState({ reorderThread });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const label = getByTestId("plot-lane-label-t1");
    fireEvent.mouseDown(label, { clientX: 70, clientY: 158 });
    fireEvent.mouseMove(document, { clientX: 70, clientY: 400 });
    // commit は早期 return（自動配置）なので、プレビューも抑止される＝
    // t1 はカーソル(400)へ追従せずホーム行に留まる（「動いたのに戻る」嘘を防ぐ）。
    const cy = Number(
      getByTestId("plot-lane-label-t1")
        .querySelector("circle")
        ?.getAttribute("cy"),
    );
    expect(cy).toBeLessThan(300); // ホーム行（158 or 214）であって 400 ではない
    fireEvent.mouseUp(document, { clientX: 70, clientY: 400 });
    expect(reorderThread).not.toHaveBeenCalled();
  });

  it("subway順トグルで実際にレーンの並び（Y）が変わる（reduced-motion で即確定）", () => {
    // アニメ完了後の確定状態を決定的に検証（rAF を回さない）。
    setReduceMotion(true);
    try {
      const scenes3 = [
        { ...mockScene, id: "s1" },
        { ...mockScene, id: "s2" },
        { ...mockScene, id: "s3" },
      ];
      usePlotThreadStore.setState({
        threads: [th("t1", "a0"), th("t2", "a1"), th("t3", "a2")],
        // t2 は 3 列 = 重要度最大、t1/t3 は 1 列。
        links: [
          lk("l1", "t1", "s1"),
          lk("l2a", "t2", "s1"),
          lk("l2b", "t2", "s2"),
          lk("l2c", "t2", "s3"),
          lk("l3", "t3", "s2"),
        ],
        branches: [],
        loading: false,
      });
      useTimelineStore.setState({
        showThreads: true,
        axisMode: "reading",
        plotSubwaySort: false,
      });
      const { getByTestId } = render(
        <TimelineViewport scenes={scenes3} onSelectScene={vi.fn()} />,
      );
      // 線形: t1 は行0（hit y = 158-28 = 130）。
      expect(getByTestId("plot-lane-hit-t1").getAttribute("y")).toBe("130");
      // subway順 ON: t1 は重要度最下位で行2（hit y = 270-28 = 242）へ。
      act(() => {
        useTimelineStore.getState().togglePlotSubwaySort();
      });
      expect(getByTestId("plot-lane-hit-t1").getAttribute("y")).toBe("242");
    } finally {
      setReduceMotion(false);
    }
  });
});

describe("TimelineViewport – 既存エッジの追従/付け替え（#2）", () => {
  beforeEach(resetStore);

  const scenes = [
    { ...mockScene, id: "s1" },
    { ...mockScene, id: "s2" },
  ];
  const th = (id: string, so: string) => ({
    id,
    projectId: "p",
    name: id,
    color: null,
    description: null,
    sortOrder: so,
    startNodeId: null,
    endNodeId: null,
    version: 0,
    createdAt: "",
    updatedAt: "",
  });
  const lk = (id: string, threadId: string, nodeId: string) => ({
    id,
    threadId,
    nodeId,
    phaseType: "introduce" as const,
    note: null,
    sortOrder: null,
    semanticKey: "",
    version: 0,
    createdAt: "",
    updatedAt: "",
  });
  // lane0=158, lane1=214, lane2=270 / s1 x=150, s2 x=246（padLeft=150）
  // branch br1: A→B @ s1。構造側マーカーは B@s1 = lB。
  function seedBranch() {
    usePlotThreadStore.setState({
      threads: [th("A", "a0"), th("B", "a1"), th("C", "a2")],
      links: [lk("lB", "B", "s1")],
      branches: [
        {
          id: "br1",
          projectId: "p",
          fromThreadId: "A",
          toThreadId: "B",
          atNodeId: "s1",
          kind: "branch" as const,
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
    });
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
  }

  it("同レーンでドラッグ → エッジの at_node が追従する", () => {
    seedBranch();
    const moveMarkerBundle = vi.fn(async () => {});
    usePlotThreadStore.setState({ moveMarkerBundle });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    // ホーム行: A=158, B=214, C=270（sortOrder 順の固定行）。
    const m = getByTestId("plot-marker-lB"); // B@s1 (x48,y214)
    fireEvent.mouseDown(m, { clientX: 150, clientY: 214 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 214 }); // 同 B レーンの s2
    fireEvent.mouseUp(document, { clientX: 246, clientY: 214 });
    expect(moveMarkerBundle).toHaveBeenCalledWith({
      markerId: "lB",
      markerPatch: { nodeId: "s2" },
      branchUpdates: [{ id: "br1", patch: { atNodeId: "s2" } }],
      branchDeletes: [],
    });
  });

  it("leaves dependent branches anchored when another marker shares the origin", () => {
    seedBranch();
    usePlotThreadStore.setState({
      links: [lk("lB", "B", "s1"), lk("lB2", "B", "s1")],
    });
    const moveMarkerBundle = vi.fn(async () => {});
    usePlotThreadStore.setState({ moveMarkerBundle });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );

    const marker = getByTestId("plot-marker-lB");
    fireEvent.mouseDown(marker, { clientX: 150, clientY: 214 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 214 });
    fireEvent.mouseUp(document, { clientX: 246, clientY: 214 });

    expect(moveMarkerBundle).toHaveBeenCalledWith({
      markerId: "lB",
      markerPatch: { nodeId: "s2" },
    });
  });

  it("別スレッドへドロップ → エッジの構造側を付け替え（新規作らない）", () => {
    seedBranch();
    const moveMarkerBundle = vi.fn(async () => {});
    usePlotThreadStore.setState({ moveMarkerBundle });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const m = getByTestId("plot-marker-lB"); // B@s1
    fireEvent.mouseDown(m, { clientX: 150, clientY: 214 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 270 }); // C レーンの s2
    fireEvent.mouseUp(document, { clientX: 246, clientY: 270 });
    // マーカーは C へ、branch の to を C へ付け替え＋at_node 追従
    expect(moveMarkerBundle).toHaveBeenCalledWith({
      markerId: "lB",
      markerPatch: {
        threadId: "C",
        nodeId: "s2",
      },
      branchUpdates: [
        {
          id: "br1",
          patch: {
            toThreadId: "C",
            atNodeId: "s2",
          },
        },
      ],
      branchDeletes: [],
    });
  });

  it("merge エッジも to 側マーカーで追従・付け替えする（統一アンカー）", () => {
    // merge mg1: A→B @s1。統一モデルで構造側マーカーは to=B@s1 = lB。
    usePlotThreadStore.setState({
      threads: [th("A", "a0"), th("B", "a1"), th("C", "a2")],
      links: [lk("lB", "B", "s1")],
      branches: [
        {
          id: "mg1",
          projectId: "p",
          fromThreadId: "A",
          toThreadId: "B",
          atNodeId: "s1",
          kind: "merge" as const,
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
    });
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
    const moveMarkerBundle = vi.fn(async () => {});
    usePlotThreadStore.setState({ moveMarkerBundle });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    // ホーム行: A=158, B=214, C=270。lB(B@s1, x48,y214) を C レーン(y270) の s2 へ。
    const m = getByTestId("plot-marker-lB");
    fireEvent.mouseDown(m, { clientX: 150, clientY: 214 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 270 });
    fireEvent.mouseUp(document, { clientX: 246, clientY: 270 });
    // マーカーは C へ、merge の to を C へ付け替え＋at_node 追従（新規作らない）。
    expect(moveMarkerBundle).toHaveBeenCalledWith({
      markerId: "lB",
      markerPatch: {
        threadId: "C",
        nodeId: "s2",
      },
      branchUpdates: [
        {
          id: "mg1",
          patch: {
            toThreadId: "C",
            atNodeId: "s2",
          },
        },
      ],
      branchDeletes: [],
    });
  });

  it("付け替えで既存エッジと重複するなら rebind せず削除する", () => {
    usePlotThreadStore.setState({
      threads: [th("A", "a0"), th("B", "a1")],
      links: [lk("lB1", "B", "s1"), lk("lB2", "B", "s2")],
      branches: [
        {
          id: "br1",
          projectId: "p",
          fromThreadId: "A",
          toThreadId: "B",
          atNodeId: "s1",
          kind: "branch" as const,
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "br2",
          projectId: "p",
          fromThreadId: "A",
          toThreadId: "B",
          atNodeId: "s2",
          kind: "branch" as const,
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
    });
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
    const moveMarkerBundle = vi.fn(async () => {});
    usePlotThreadStore.setState({ moveMarkerBundle });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    // ホーム行: A=158, B=214（sortOrder 順の固定行）。
    const m = getByTestId("plot-marker-lB1"); // B@s1 (x48,y214)
    fireEvent.mouseDown(m, { clientX: 150, clientY: 214 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 214 }); // B レーンの s2
    fireEvent.mouseUp(document, { clientX: 246, clientY: 214 });
    // br1 が A→B@s2 になり br2 と重複 → rebind せず br1 を削除
    expect(moveMarkerBundle).toHaveBeenCalledWith({
      markerId: "lB1",
      markerPatch: { nodeId: "s2" },
      branchUpdates: [],
      branchDeletes: ["br1"],
    });
  });
});

describe("TimelineViewport – ヘッダー hover dim（色違い merge/branch 除外）", () => {
  beforeEach(resetStore);

  const scenes = [
    { ...mockScene, id: "s1" },
    { ...mockScene, id: "s2" },
  ];
  const th = (id: string, so: string, color: string | null) => ({
    id,
    projectId: "p",
    name: id,
    color,
    description: null,
    sortOrder: so,
    startNodeId: null,
    endNodeId: null,
    version: 0,
    createdAt: "",
    updatedAt: "",
  });
  const lk = (id: string, threadId: string, nodeId: string) => ({
    id,
    threadId,
    nodeId,
    phaseType: "introduce" as const,
    note: null,
    sortOrder: null,
    semanticKey: "",
    version: 0,
    createdAt: "",
    updatedAt: "",
  });

  it("from 側 hover はコネクタ点灯・色違いの to 側 hover は dim", () => {
    usePlotThreadStore.setState({
      threads: [th("t1", "a0", "#ff0000"), th("t2", "a1", "#00ff00")],
      links: [lk("l1", "t1", "s1"), lk("l2", "t2", "s2")],
      branches: [
        {
          id: "br1",
          projectId: "p",
          fromThreadId: "t1",
          toThreadId: "t2",
          atNodeId: "s2",
          kind: "branch" as const,
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
    });
    useTimelineStore.setState({
      showThreads: true,
      axisMode: "reading",
    });
    const { getByTestId, container } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const conn = () =>
      container.querySelector(
        '[data-testid="plot-thread-connector"]',
      ) as SVGElement;
    expect(conn()).toBeTruthy();
    // from=t1（コネクタ色 #ff0000 = t1 色）を hover → 点灯。
    fireEvent.mouseEnter(getByTestId("plot-lane-label-t1"));
    const litOp = conn().style.opacity;
    expect(litOp === "" || Number(litOp) === 1).toBe(true);
    // to=t2（色 #00ff00 ≠ コネクタ色 #ff0000）を hover → 別スレッド由来なので dim。
    fireEvent.mouseLeave(getByTestId("plot-lane-label-t1"));
    fireEvent.mouseEnter(getByTestId("plot-lane-label-t2"));
    expect(Number(conn().style.opacity)).toBeLessThan(1);
  });
});

describe("TimelineViewport – フォルダ構造グルーピング帯（X軸）", () => {
  beforeEach(resetStore);

  const scenes = [
    { ...mockScene, id: "s1" },
    { ...mockScene, id: "s2" },
    { ...mockScene, id: "s3" },
  ];

  it("folderGroups を渡すと部/章の帯を2段描く", () => {
    const { container } = render(
      <TimelineViewport
        scenes={scenes}
        onSelectScene={vi.fn()}
        folderGroups={[
          [{ startIndex: 0, endIndex: 2, id: "P", label: "部P" }],
          [
            { startIndex: 0, endIndex: 1, id: "A", label: "章A" },
            { startIndex: 2, endIndex: 2, id: "B", label: "章B" },
          ],
        ]}
      />,
    );
    expect(
      container.querySelector('[data-testid="folder-band-level-0"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="folder-band-level-1"]'),
    ).toBeTruthy();
    // 部1 + 章2 = 3 本の帯
    expect(
      container.querySelectorAll('[data-testid="folder-band"]').length,
    ).toBe(3);
  });

  it("folderGroups 未指定（既定）では帯を描かない", () => {
    const { container } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    expect(
      container.querySelectorAll('[data-testid="folder-band"]').length,
    ).toBe(0);
  });

  it("3段以上でも最大2段までしか描かない", () => {
    const { container } = render(
      <TimelineViewport
        scenes={scenes}
        onSelectScene={vi.fn()}
        folderGroups={[
          [{ startIndex: 0, endIndex: 2, id: "P", label: "部" }],
          [{ startIndex: 0, endIndex: 2, id: "A", label: "章" }],
          [{ startIndex: 0, endIndex: 2, id: "X", label: "節" }],
        ]}
      />,
    );
    expect(
      container.querySelector('[data-testid="folder-band-level-2"]'),
    ).toBeNull();
  });
});

describe("TimelineViewport – thread gaps (1c)", () => {
  beforeEach(resetStore);

  const gapScenes: TreeNodeData[] = ["s0", "s1", "s2", "s3"].map((id, i) => ({
    ...mockScene,
    id,
    title: id,
    sortOrder: `a${i}`,
  }));

  function setupGapThread() {
    usePlotThreadStore.setState({
      threads: [
        {
          id: "t1",
          projectId: "proj-1",
          name: "T1",
          color: "#ff0000",
          description: null,
          sortOrder: "a0",
          startNodeId: null,
          endNodeId: null,
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      links: [
        {
          id: "l1",
          threadId: "t1",
          nodeId: "s0",
          phaseType: "introduce",
          note: null,
          sortOrder: null,
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "l2",
          threadId: "t1",
          nodeId: "s3",
          phaseType: "resolve",
          note: null,
          sortOrder: null,
          semanticKey: "",
          version: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
      branches: [],
      loading: false,
    });
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
  }

  it("showThreadGaps ON でマーカー間の抜け列に目印が出る", () => {
    setupGapThread();
    useTimelineStore.setState((s) => ({
      display: { ...s.display, showThreadGaps: true },
    }));
    const { container } = render(
      <TimelineViewport scenes={gapScenes} onSelectScene={vi.fn()} />,
    );
    const gaps = container.querySelectorAll(
      '[data-testid^="plot-thread-gap-t1-"]',
    );
    expect(gaps.length).toBe(2); // col1, col2（col0/col3 はマーカー）
  });

  it("showThreadGaps OFF では目印が出ない", () => {
    setupGapThread();
    const { container } = render(
      <TimelineViewport scenes={gapScenes} onSelectScene={vi.fn()} />,
    );
    const gaps = container.querySelectorAll(
      '[data-testid^="plot-thread-gap-"]',
    );
    expect(gaps.length).toBe(0);
  });

  it("reading-order 以外（story/write）では gap を描かない", () => {
    setupGapThread();
    useTimelineStore.setState((s) => ({
      axisMode: "story",
      display: { ...s.display, showThreadGaps: true },
    }));
    const { container } = render(
      <TimelineViewport scenes={gapScenes} onSelectScene={vi.fn()} />,
    );
    const gaps = container.querySelectorAll(
      '[data-testid^="plot-thread-gap-"]',
    );
    expect(gaps.length).toBe(0);
  });
});
