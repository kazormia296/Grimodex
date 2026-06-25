// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TimelineHeader } from "./TimelineHeader";
import { useTimelineStore } from "./timelineStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";

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
    showThreads: false,
    plotLayout: "subway",
    plotSubwaySort: false,
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

describe("TimelineHeader – スレッド表示トグル", () => {
  beforeEach(resetStore);

  it("「スレッド」クリックで showThreads が ON/OFF トグルする", () => {
    renderHeader();
    fireEvent.click(screen.getByText("スレッド"));
    expect(useTimelineStore.getState().showThreads).toBe(true);
    fireEvent.click(screen.getByText("スレッド"));
    expect(useTimelineStore.getState().showThreads).toBe(false);
  });

  it("スレッド追加時に Codex パレットから順番に色を自動割り当てる", () => {
    const addThread = vi.fn();
    useTimelineStore.setState({ showThreads: true });
    usePlotThreadStore.setState({ threads: [], addThread });
    renderHeader();
    fireEvent.click(screen.getByTitle("スレッドを追加"));
    // simple(既定) light スロット0 = Blue #2045AA を 3 引数目で渡す。
    expect(addThread).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "#2045AA",
    );
  });

  it("スレッド表示中のみスレッド追加ボタンが出る", () => {
    const { rerender } = renderHeader();
    expect(screen.queryByTitle("スレッドを追加")).toBeNull();
    useTimelineStore.setState({ showThreads: true });
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

describe("TimelineHeader – レイアウト(subway/separated)トグル", () => {
  beforeEach(resetStore);

  it("スレッド非表示のときレイアウトトグルは出ない", () => {
    renderHeader();
    expect(screen.queryByRole("group", { name: /レイアウト/ })).toBeNull();
  });

  it("スレッド表示中にトグルが出て、Separated クリックで plotLayout が切替＋aria-pressed 更新", () => {
    useTimelineStore.setState({ showThreads: true, plotLayout: "subway" });
    renderHeader();
    const group = screen.getByRole("group", { name: /レイアウト/ });
    expect(group).toBeTruthy();
    const subwayBtn = screen.getByTitle("Subway");
    const separatedBtn = screen.getByTitle("Separated");
    // 既定は subway が押下状態。
    expect(subwayBtn.getAttribute("aria-pressed")).toBe("true");
    expect(separatedBtn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(separatedBtn);
    expect(useTimelineStore.getState().plotLayout).toBe("separated");
    expect(separatedBtn.getAttribute("aria-pressed")).toBe("true");
    expect(subwayBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("subway順トグルは separated のときだけ出て plotSubwaySort を切り替える", () => {
    // subway レイアウトでは出ない。
    useTimelineStore.setState({ showThreads: true, plotLayout: "subway" });
    const { unmount } = renderHeader();
    expect(screen.queryByText("subway順")).toBeNull();
    unmount();
    // separated に切替えると出る。
    useTimelineStore.setState({ plotLayout: "separated" });
    renderHeader();
    const btn = screen.getByText("subway順");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(useTimelineStore.getState().plotSubwaySort).toBe(true);
  });
});
