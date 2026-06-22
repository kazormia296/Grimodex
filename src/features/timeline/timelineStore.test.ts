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
    viewMode: "scenes",
    zoom: 1,
    scrollOffset: 0,
    selectedNodeIds: [],
    inspectorOpen: false,
    display: {
      showTitles: true,
      showChapterNumbers: true,
      showPhasePins: false,
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

  it("viewMode は scenes が既定で、setViewMode で threads に切り替わる", () => {
    expect(useTimelineStore.getState().viewMode).toBe("scenes");
    useTimelineStore.getState().setViewMode("threads");
    expect(useTimelineStore.getState().viewMode).toBe("threads");
  });
});

describe("timelineStore.loadFromSettings", () => {
  beforeEach(reset);

  it("全フィールドを正しく復元する", () => {
    const s: TimelineSettings = {
      axisMode: "story",
      spacingMode: "proportional",
      viewMode: "threads",
      zoom: 2,
      scrollOffset: 120,
      display: {
        showTitles: false,
        showChapterNumbers: false,
        showPhasePins: true,
      },
    };
    useTimelineStore.getState().loadFromSettings(s);
    const state = useTimelineStore.getState();
    expect(state.axisMode).toBe("story");
    expect(state.spacingMode).toBe("proportional");
    expect(state.viewMode).toBe("threads");
    expect(state.zoom).toBe(2);
    expect(state.scrollOffset).toBe(120);
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
      },
    });
    vi.runAllTimers();
    expect(invoke).not.toHaveBeenCalledWith(
      "save_global_settings",
      expect.anything(),
    );
  });
});
