// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { TimelineViewport } from "./TimelineViewport";
import { useTimelineStore } from "./timelineStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { useSettingsStore } from "@/features/settings/settingsStore";

/** reduced-motion を強制（アニメ無し＝即時確定）して toggle/settled を決定的に検証する。 */
function setReduceMotion(on: boolean) {
  useSettingsStore.setState((s) => ({
    cache: { ...s.cache, "display.reduceMotion": on ? "true" : "false" },
  }));
}

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(), isTauri: () => false }));

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

  it("プレーンなホイール（縦回転 上）でズームインする", () => {
    const container = renderViewport();
    act(() => {
      fireEvent.wheel(container, { deltaY: -100, deltaX: 0 });
    });
    expect(useTimelineStore.getState().zoom).toBeCloseTo(1.25);
  });

  it("プレーンなホイール（縦回転 下）でズームアウトする", () => {
    const container = renderViewport();
    act(() => {
      fireEvent.wheel(container, { deltaY: 100, deltaX: 0 });
    });
    expect(useTimelineStore.getState().zoom).toBeCloseTo(1 / 1.25);
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

  it("merge の流入先マーカーは subway 風の白丸ドーナツで描く", () => {
    seedThreads(); // t1: l1@s1, l2@s3
    usePlotThreadStore.setState({
      branches: [
        {
          id: "mg1",
          projectId: "p",
          fromThreadId: "t2",
          toThreadId: "t1",
          atNodeId: "s3", // t1@s3 = l2 が merge の流入先
          kind: "merge",
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
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

  it("同レーンで横ドラッグ → updateMarker でシーン移動", () => {
    seed();
    const updateMarker = vi.fn();
    usePlotThreadStore.setState({ updateMarker });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const m = getByTestId("plot-marker-l1");
    fireEvent.mouseDown(m, { clientX: 150, clientY: 158 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 158 });
    fireEvent.mouseUp(document, { clientX: 246, clientY: 158 });
    expect(updateMarker).toHaveBeenCalledWith("l1", { nodeId: "s2" });
  });

  it("マーカードラッグ中はグラフを再計算しプレビューのコネクタが出る（確定前）", () => {
    seed();
    usePlotThreadStore.setState({
      updateMarker: vi.fn(),
      addMarker: vi.fn(),
      addBranch: vi.fn(),
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
    expect(conns()).toBeGreaterThan(0); // ライブ再計算でプレビュー・コネクタ
    fireEvent.mouseUp(document, { clientX: 246, clientY: 214 });
  });

  it("下のレーンへドラッグ → branch: ドラッグ点を先(to)へ移動・元に点は作らない", () => {
    seed();
    const updateMarker = vi.fn();
    const addMarker = vi.fn();
    const addBranch = vi.fn();
    usePlotThreadStore.setState({ updateMarker, addMarker, addBranch });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const m = getByTestId("plot-marker-l1"); // t1(上)@s1
    // t2(下, y214) の s2(x144) へ → branch。点は t2 へ移動、元 t1 には作らない。
    fireEvent.mouseDown(m, { clientX: 150, clientY: 158 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 214 });
    fireEvent.mouseUp(document, { clientX: 246, clientY: 214 });
    expect(updateMarker).toHaveBeenCalledWith("l1", {
      threadId: "t2",
      nodeId: "s2",
    });
    expect(addMarker).not.toHaveBeenCalled(); // 第2の点は作らない
    expect(addBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        fromThreadId: "t1",
        toThreadId: "t2",
        atNodeId: "s2",
        kind: "branch",
      }),
    );
  });

  it("上のレーンへドラッグ → merge: ドラッグ点を移動先(to)へ移す・元に点は作らない", () => {
    seed();
    const updateMarker = vi.fn();
    const addMarker = vi.fn();
    const addBranch = vi.fn();
    usePlotThreadStore.setState({ updateMarker, addMarker, addBranch });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const m = getByTestId("plot-marker-l2"); // t2(下)@s1
    // t1(上, y158) の s2(x144) へ → merge。統一モデルで点は移動先 to=t1 へ移す。元 t2 には残さない。
    fireEvent.mouseDown(m, { clientX: 150, clientY: 214 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 158 });
    fireEvent.mouseUp(document, { clientX: 246, clientY: 158 });
    expect(updateMarker).toHaveBeenCalledWith("l2", {
      threadId: "t1",
      nodeId: "s2",
    });
    expect(addMarker).not.toHaveBeenCalled();
    expect(addBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        fromThreadId: "t2",
        toThreadId: "t1",
        atNodeId: "s2",
        kind: "merge",
      }),
    );
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
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
    });
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
    const updateMarker = vi.fn();
    const addMarker = vi.fn();
    const addBranch = vi.fn();
    usePlotThreadStore.setState({ updateMarker, addMarker, addBranch });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    // l1 = t1@s2(x144,y158) を t2 レーン(y214) の s2(x144) へ → 同一エッジで dup
    const m = getByTestId("plot-marker-l1");
    fireEvent.mouseDown(m, { clientX: 246, clientY: 158 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 214 });
    fireEvent.mouseUp(document, { clientX: 246, clientY: 214 });
    // dup なので何も起きない（source も動かない）
    expect(updateMarker).not.toHaveBeenCalled();
    expect(addMarker).not.toHaveBeenCalled();
    expect(addBranch).not.toHaveBeenCalled();
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
    seed();
    usePlotThreadStore.setState({ reorderThread: vi.fn() });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const l1 = getByTestId("plot-lane-label-t1");
    // t1(行0,y158) を y200 へドラッグ（2スレッドの帯 [158,214] 内）。mouseup 前を検証。
    fireEvent.mouseDown(l1, { clientX: 70, clientY: 158 });
    fireEvent.mouseMove(document, { clientX: 70, clientY: 200 });
    // 左ガターのラベルの丸がカーソル Y へ即時追従。
    const circle = getByTestId("plot-lane-label-t1").querySelector("circle");
    expect(circle?.getAttribute("cy")).toBe("200");
    // グラフ側のレーン（ヒット領域 = lane.y - LANE_HEIGHT/2 = 200-28）も一緒に動く。
    expect(getByTestId("plot-lane-hit-t1").getAttribute("y")).toBe("172");
    fireEvent.mouseUp(document, { clientX: 70, clientY: 200 });
  });

  it("ドラッグ点を列の外（下端より下）へ動かしても帯内にクランプされ見切れない", () => {
    seed();
    usePlotThreadStore.setState({ reorderThread: vi.fn() });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const l1 = getByTestId("plot-lane-label-t1");
    // 2スレッドの最終行 Y = 158 + 56 = 214。はるか下(2000)へドラッグ。
    fireEvent.mouseDown(l1, { clientX: 70, clientY: 158 });
    fireEvent.mouseMove(document, { clientX: 70, clientY: 2000 });
    const cy = Number(
      getByTestId("plot-lane-label-t1")
        .querySelector("circle")
        ?.getAttribute("cy"),
    );
    expect(cy).toBe(214); // 最終行へクランプ（2000 まで追従しない）
    fireEvent.mouseUp(document, { clientX: 70, clientY: 2000 });
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
    const updateMarker = vi.fn();
    const updateBranch = vi.fn();
    const addBranch = vi.fn();
    usePlotThreadStore.setState({ updateMarker, updateBranch, addBranch });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    // ホーム行: A=158, B=214, C=270（sortOrder 順の固定行）。
    const m = getByTestId("plot-marker-lB"); // B@s1 (x48,y214)
    fireEvent.mouseDown(m, { clientX: 150, clientY: 214 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 214 }); // 同 B レーンの s2
    fireEvent.mouseUp(document, { clientX: 246, clientY: 214 });
    expect(updateMarker).toHaveBeenCalledWith("lB", { nodeId: "s2" });
    expect(updateBranch).toHaveBeenCalledWith("br1", { atNodeId: "s2" });
    expect(addBranch).not.toHaveBeenCalled();
  });

  it("別スレッドへドロップ → エッジの構造側を付け替え（新規作らない）", () => {
    seedBranch();
    const updateMarker = vi.fn();
    const updateBranch = vi.fn();
    const addBranch = vi.fn();
    usePlotThreadStore.setState({ updateMarker, updateBranch, addBranch });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    const m = getByTestId("plot-marker-lB"); // B@s1
    fireEvent.mouseDown(m, { clientX: 150, clientY: 214 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 270 }); // C レーンの s2
    fireEvent.mouseUp(document, { clientX: 246, clientY: 270 });
    // マーカーは C へ、branch の to を C へ付け替え＋at_node 追従
    expect(updateMarker).toHaveBeenCalledWith("lB", {
      threadId: "C",
      nodeId: "s2",
    });
    expect(updateBranch).toHaveBeenCalledWith("br1", {
      toThreadId: "C",
      atNodeId: "s2",
    });
    expect(addBranch).not.toHaveBeenCalled();
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
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
    });
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
    const updateMarker = vi.fn();
    const updateBranch = vi.fn();
    const addBranch = vi.fn();
    usePlotThreadStore.setState({ updateMarker, updateBranch, addBranch });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    // ホーム行: A=158, B=214, C=270。lB(B@s1, x48,y214) を C レーン(y270) の s2 へ。
    const m = getByTestId("plot-marker-lB");
    fireEvent.mouseDown(m, { clientX: 150, clientY: 214 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 270 });
    fireEvent.mouseUp(document, { clientX: 246, clientY: 270 });
    // マーカーは C へ、merge の to を C へ付け替え＋at_node 追従（新規作らない）。
    expect(updateMarker).toHaveBeenCalledWith("lB", {
      threadId: "C",
      nodeId: "s2",
    });
    expect(updateBranch).toHaveBeenCalledWith("mg1", {
      toThreadId: "C",
      atNodeId: "s2",
    });
    expect(addBranch).not.toHaveBeenCalled();
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
          createdAt: "",
          updatedAt: "",
        },
      ],
      loading: false,
    });
    useTimelineStore.setState({ showThreads: true, axisMode: "reading" });
    const updateMarker = vi.fn();
    const updateBranch = vi.fn();
    const deleteBranch = vi.fn();
    usePlotThreadStore.setState({ updateMarker, updateBranch, deleteBranch });
    const { getByTestId } = render(
      <TimelineViewport scenes={scenes} onSelectScene={vi.fn()} />,
    );
    // ホーム行: A=158, B=214（sortOrder 順の固定行）。
    const m = getByTestId("plot-marker-lB1"); // B@s1 (x48,y214)
    fireEvent.mouseDown(m, { clientX: 150, clientY: 214 });
    fireEvent.mouseMove(document, { clientX: 246, clientY: 214 }); // B レーンの s2
    fireEvent.mouseUp(document, { clientX: 246, clientY: 214 });
    // br1 が A→B@s2 になり br2 と重複 → rebind せず br1 を削除
    expect(deleteBranch).toHaveBeenCalledWith("br1");
    expect(updateBranch).not.toHaveBeenCalled();
    expect(updateMarker).toHaveBeenCalledWith("lB1", { nodeId: "s2" });
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
