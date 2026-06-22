// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TimelineHeader } from "./TimelineHeader";
import { useTimelineStore } from "./timelineStore";

function renderHeader(
  overrides?: Partial<Parameters<typeof TimelineHeader>[0]>,
) {
  return render(
    <TimelineHeader
      sceneCount={10}
      scheduledCount={null}
      inspectorOpen={false}
      onToggleInspector={() => {}}
      {...overrides}
    />,
  );
}

function resetStore() {
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

describe("TimelineHeader – Spacing mode UI", () => {
  beforeEach(resetStore);

  it("spacing モードドロップダウンが表示される", () => {
    renderHeader();
    expect(screen.getByTestId("spacing-mode-select")).toBeDefined();
  });

  it("axisMode=reading のとき disabled で Uniform 固定", () => {
    useTimelineStore.setState({ axisMode: "reading", spacingMode: "uniform" });
    renderHeader();
    const select = screen.getByTestId(
      "spacing-mode-select",
    ) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("uniform");
  });

  it("axisMode=story のとき enabled で Proportional がデフォルト", () => {
    useTimelineStore.setState({
      axisMode: "story",
      spacingMode: "proportional",
    });
    renderHeader();
    const select = screen.getByTestId(
      "spacing-mode-select",
    ) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(select.value).toBe("proportional");
  });

  it("axisMode=write のとき enabled", () => {
    useTimelineStore.setState({
      axisMode: "write",
      spacingMode: "proportional",
    });
    renderHeader();
    const select = screen.getByTestId(
      "spacing-mode-select",
    ) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
  });

  it("spacing 変更で setSpacingMode が呼ばれ store が更新される", () => {
    useTimelineStore.setState({
      axisMode: "story",
      spacingMode: "proportional",
    });
    renderHeader();
    const select = screen.getByTestId(
      "spacing-mode-select",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "uniform" } });
    expect(useTimelineStore.getState().spacingMode).toBe("uniform");
  });

  it("axisMode=reading に切り替えると spacing が uniform に戻る", () => {
    useTimelineStore.setState({
      axisMode: "story",
      spacingMode: "proportional",
    });
    renderHeader();
    const axisSelect = screen.getByLabelText(
      "時間軸モード",
    ) as HTMLSelectElement;
    fireEvent.change(axisSelect, { target: { value: "reading" } });
    expect(useTimelineStore.getState().spacingMode).toBe("uniform");
  });
});

describe("TimelineHeader – view mode toggle", () => {
  beforeEach(resetStore);

  it("「スレッド」クリックで viewMode が threads になる", () => {
    renderHeader();
    fireEvent.click(screen.getByText("スレッド"));
    expect(useTimelineStore.getState().viewMode).toBe("threads");
  });

  it("「シーン」クリックで viewMode が scenes に戻る", () => {
    useTimelineStore.setState({ viewMode: "threads" });
    renderHeader();
    fireEvent.click(screen.getByText("シーン"));
    expect(useTimelineStore.getState().viewMode).toBe("scenes");
  });

  it("threads モードのときだけスレッド追加ボタンが出る", () => {
    const { rerender } = renderHeader();
    expect(screen.queryByTitle("スレッドを追加")).toBeNull();
    useTimelineStore.setState({ viewMode: "threads" });
    rerender(
      <TimelineHeader
        sceneCount={10}
        scheduledCount={null}
        inspectorOpen={false}
        onToggleInspector={() => {}}
      />,
    );
    expect(screen.getByTitle("スレッドを追加")).toBeTruthy();
  });
});
