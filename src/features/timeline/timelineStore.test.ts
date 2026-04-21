import { describe, it, expect, beforeEach } from "vitest";
import { useTimelineStore } from "./timelineStore";
import type { TimelineSettings } from "./timelineStore";

function reset() {
  useTimelineStore.setState({
    axisMode: "reading",
    spacingMode: "uniform",
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
});

describe("timelineStore.loadFromSettings", () => {
  beforeEach(reset);

  it("全フィールドを正しく復元する", () => {
    const s: TimelineSettings = {
      axisMode: "story",
      spacingMode: "proportional",
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
