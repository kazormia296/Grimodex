import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useTimelineStore, loadAndSyncTimelineSettings } from "./timelineStore";
import type { TimelineSettings } from "./timelineStore";
import { invoke } from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

function reset() {
  useTimelineStore.setState({
    axisMode: "reading",
    spacingMode: "uniform",
    showThreads: true,
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
}

describe("timelineStore", () => {
  beforeEach(reset);

  it("setAxisMode to story switches spacingMode to proportional", () => {
    useTimelineStore.getState().setAxisMode("story");
    expect(useTimelineStore.getState().axisMode).toBe("story");
    expect(useTimelineStore.getState().spacingMode).toBe("proportional");
  });

  it("setAxisMode to reading switches spacingMode to uniform", () => {
    useTimelineStore.getState().setAxisMode("story");
    useTimelineStore.getState().setAxisMode("reading");
    expect(useTimelineStore.getState().spacingMode).toBe("uniform");
  });

  it("setZoom clamps to [0.25, 4]", () => {
    useTimelineStore.getState().setZoom(0);
    expect(useTimelineStore.getState().zoom).toBe(0.25);
    useTimelineStore.getState().setZoom(10);
    expect(useTimelineStore.getState().zoom).toBe(4);
    useTimelineStore.getState().setZoom(1.5);
    expect(useTimelineStore.getState().zoom).toBe(1.5);
  });

  it("selectNode replaces selection", () => {
    useTimelineStore.setState({ selectedNodeIds: ["a", "b"] });
    useTimelineStore.getState().selectNode("c");
    expect(useTimelineStore.getState().selectedNodeIds).toEqual(["c"]);
  });

  it("clearSelection empties selectedNodeIds", () => {
    useTimelineStore.setState({ selectedNodeIds: ["a"] });
    useTimelineStore.getState().clearSelection();
    expect(useTimelineStore.getState().selectedNodeIds).toEqual([]);
  });

  it("toggleDisplay flips a display key", () => {
    expect(useTimelineStore.getState().display.showPhasePins).toBe(false);
    useTimelineStore.getState().toggleDisplay("showPhasePins");
    expect(useTimelineStore.getState().display.showPhasePins).toBe(true);
    useTimelineStore.getState().toggleDisplay("showPhasePins");
    expect(useTimelineStore.getState().display.showPhasePins).toBe(false);
  });

  it("showStructureAnalysis は既定 false で toggleDisplay で切り替わる", () => {
    expect(useTimelineStore.getState().display.showStructureAnalysis).toBe(
      false,
    );
    useTimelineStore.getState().toggleDisplay("showStructureAnalysis");
    expect(useTimelineStore.getState().display.showStructureAnalysis).toBe(
      true,
    );
  });

  it("toggleInspector flips inspectorOpen", () => {
    expect(useTimelineStore.getState().inspectorOpen).toBe(false);
    useTimelineStore.getState().toggleInspector();
    expect(useTimelineStore.getState().inspectorOpen).toBe(true);
  });

  it("toggleSelect 未選択 → 追加", () => {
    useTimelineStore.getState().toggleSelect("a");
    expect(useTimelineStore.getState().selectedNodeIds).toEqual(["a"]);
  });

  it("toggleSelect 選択済み → 除外", () => {
    useTimelineStore.setState({ selectedNodeIds: ["a", "b"] });
    useTimelineStore.getState().toggleSelect("a");
    expect(useTimelineStore.getState().selectedNodeIds).toEqual(["b"]);
  });

  it("rangeSelectTo が lastSingleSelectId から対象 id まで選択する", () => {
    useTimelineStore.setState({ selectedNodeIds: ["b"] });
    useTimelineStore.getState().rangeSelectTo("d", ["a", "b", "c", "d", "e"]);
    const ids = useTimelineStore.getState().selectedNodeIds;
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    expect(ids).toContain("d");
    expect(ids).not.toContain("a");
    expect(ids).not.toContain("e");
  });

  it("rangeSelectTo: 選択なし → 先頭から指定ノードまで", () => {
    useTimelineStore.getState().rangeSelectTo("c", ["a", "b", "c", "d"]);
    const ids = useTimelineStore.getState().selectedNodeIds;
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    expect(ids).not.toContain("d");
  });

  it("setPendingEditNodeId でラベル編集ターゲットを設定できる", () => {
    useTimelineStore.getState().setPendingEditNodeId("node-42");
    expect(useTimelineStore.getState().pendingEditNodeId).toBe("node-42");
    useTimelineStore.getState().setPendingEditNodeId(null);
    expect(useTimelineStore.getState().pendingEditNodeId).toBeNull();
  });

  it("showThreads は既定 true（スレッドは常時表示・切替 UI 撤去）", () => {
    expect(useTimelineStore.getState().showThreads).toBe(true);
  });

  it("plotSubwaySort を togglePlotSubwaySort で切り替える", () => {
    expect(useTimelineStore.getState().plotSubwaySort).toBe(false);
    useTimelineStore.getState().togglePlotSubwaySort();
    expect(useTimelineStore.getState().plotSubwaySort).toBe(true);
    useTimelineStore.getState().togglePlotSubwaySort();
    expect(useTimelineStore.getState().plotSubwaySort).toBe(false);
  });
});

describe("timelineStore.loadFromSettings", () => {
  beforeEach(reset);

  it("全フィールドを正しく復元する", () => {
    const s: TimelineSettings = {
      axisMode: "story",
      spacingMode: "proportional",
      showThreads: true,
      zoom: 2,
      scrollOffset: 120,
      inspectorWidth: 300,
      display: {
        showTitles: false,
        showChapterNumbers: false,
        showPhasePins: true,
        showThreadGaps: false,
        showStructureAnalysis: false,
      },
    };
    useTimelineStore.getState().loadFromSettings(s);
    const state = useTimelineStore.getState();
    expect(state.axisMode).toBe("story");
    expect(state.spacingMode).toBe("proportional");
    expect(state.showThreads).toBe(true);
    expect(state.zoom).toBe(2);
    expect(state.scrollOffset).toBe(120);
    expect(state.inspectorWidth).toBe(300);
    expect(state.display.showPhasePins).toBe(true);
    expect(state.display.showTitles).toBe(false);
  });

  it("部分オブジェクトでもデフォルト値にフォールバックする", () => {
    useTimelineStore.getState().loadFromSettings({} as TimelineSettings);
    const state = useTimelineStore.getState();
    expect(state.axisMode).toBe("reading");
    expect(state.zoom).toBe(1);
    expect(state.display.showTitles).toBe(true);
  });

  it("showThreads は常時 true で読み込まれる（旧 plotLayout/viewMode は読み捨て）", () => {
    useTimelineStore.getState().loadFromSettings({
      showThreads: false,
      viewMode: "scenes",
    } as unknown as Partial<TimelineSettings>);
    expect(useTimelineStore.getState().showThreads).toBe(true);
  });

  it("setInspectorWidth は [160,480] にクランプし丸める", () => {
    const set = useTimelineStore.getState().setInspectorWidth;
    set(300);
    expect(useTimelineStore.getState().inspectorWidth).toBe(300);
    set(10); // 下限
    expect(useTimelineStore.getState().inspectorWidth).toBe(160);
    set(9999); // 上限
    expect(useTimelineStore.getState().inspectorWidth).toBe(480);
    set(223.6); // 丸め
    expect(useTimelineStore.getState().inspectorWidth).toBe(224);
  });

  it("zoom は [0.25, 4] にクランプされる", () => {
    useTimelineStore
      .getState()
      .loadFromSettings({ zoom: 99 } as TimelineSettings);
    expect(useTimelineStore.getState().zoom).toBe(4);
    useTimelineStore
      .getState()
      .loadFromSettings({ zoom: -1 } as TimelineSettings);
    expect(useTimelineStore.getState().zoom).toBe(0.25);
  });
});

describe("timelineStore persistent subscriber", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reset();
    vi.clearAllTimers();
    vi.mocked(invoke).mockResolvedValue({ recentWorkspaces: [], timeline: {} });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("inspectorOpen の変更では save IPC が発火しない", () => {
    useTimelineStore.getState().toggleInspector();
    vi.runAllTimers();
    expect(invoke).not.toHaveBeenCalledWith(
      "save_global_settings",
      expect.anything(),
    );
  });

  it("selectNode の変更では save IPC が発火しない", () => {
    useTimelineStore.getState().selectNode("node-1");
    vi.runAllTimers();
    expect(invoke).not.toHaveBeenCalledWith(
      "save_global_settings",
      expect.anything(),
    );
  });

  it("clearSelection の変更では save IPC が発火しない", () => {
    useTimelineStore.setState({ selectedNodeIds: ["a"] });
    vi.clearAllTimers();
    vi.clearAllMocks();
    useTimelineStore.getState().clearSelection();
    vi.runAllTimers();
    expect(invoke).not.toHaveBeenCalledWith(
      "save_global_settings",
      expect.anything(),
    );
  });

  it("zoom 変更では save IPC が発火する", async () => {
    useTimelineStore.getState().setZoom(2);
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenCalledWith(
      "save_global_settings",
      expect.objectContaining({
        settings: expect.objectContaining({
          timeline: expect.objectContaining({ zoom: 2 }),
        }),
      }),
    );
  });

  it("plotSubwaySort 変更で save IPC に plotSubwaySort が乗る", async () => {
    useTimelineStore.getState().togglePlotSubwaySort();
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenCalledWith(
      "save_global_settings",
      expect.objectContaining({
        settings: expect.objectContaining({
          timeline: expect.objectContaining({ plotSubwaySort: true }),
        }),
      }),
    );
  });

  it("showStructureAnalysis 変更で save IPC に display.showStructureAnalysis が乗る", async () => {
    useTimelineStore.getState().toggleDisplay("showStructureAnalysis");
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenCalledWith(
      "save_global_settings",
      expect.objectContaining({
        settings: expect.objectContaining({
          timeline: expect.objectContaining({
            display: expect.objectContaining({ showStructureAnalysis: true }),
          }),
        }),
      }),
    );
  });

  it("loadAndSyncTimelineSettings 直後は save IPC が発火しない", () => {
    loadAndSyncTimelineSettings({
      axisMode: "story",
      spacingMode: "proportional",
      zoom: 2,
      scrollOffset: 100,
      display: {
        showTitles: false,
        showChapterNumbers: false,
        showPhasePins: true,
        showThreadGaps: false,
        showStructureAnalysis: false,
      },
    });
    vi.runAllTimers();
    expect(invoke).not.toHaveBeenCalledWith(
      "save_global_settings",
      expect.anything(),
    );
  });
});
