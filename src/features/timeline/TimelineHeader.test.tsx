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
    showThreads: true,
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

describe("TimelineHeader – スレッド追加（常時表示）", () => {
  beforeEach(resetStore);

  it("スレッド追加ボタンは常に表示され、Codex パレットから色を自動割り当てる", () => {
    const addThread = vi.fn();
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

  it("subway/separated 切替トグルは存在しない（撤去済み）", () => {
    renderHeader();
    expect(screen.queryByTitle("Subway")).toBeNull();
    expect(screen.queryByTitle("Separated")).toBeNull();
    expect(screen.queryByText("スレッド")).toBeNull();
  });
});

describe("TimelineHeader – 表示オプション（ケバブ）", () => {
  beforeEach(resetStore);

  it("ケバブとインスペクタ（サイドペイン）ボタンが別々に存在する", () => {
    renderHeader();
    // 表示オプションのケバブ。
    expect(screen.getByTestId("timeline-display-menu")).toBeTruthy();
    // インスペクタ開閉は別ボタン（⋮ ではなくサイドペインアイコン）。
    const inspectorBtn = screen.getByTitle("インスペクター");
    expect(inspectorBtn).toBeTruthy();
    expect(inspectorBtn.textContent).not.toContain("⋮");
  });

  it("インスペクタボタンで onToggleInspector が呼ばれ aria-pressed が状態に追従する", () => {
    const onToggleInspector = vi.fn();
    renderHeader({ inspectorOpen: true, onToggleInspector });
    const btn = screen.getByTitle("インスペクター");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    expect(onToggleInspector).toHaveBeenCalled();
  });
});

describe("TimelineHeader – a11y（アイコンボタンの accessible name / focus indicator）", () => {
  beforeEach(resetStore);

  it("表示オプション（ケバブ）に title と同値の aria-label がある", () => {
    renderHeader();
    const trigger = screen.getByTestId("timeline-display-menu");
    const label = trigger.getAttribute("aria-label");
    expect(label).toBeTruthy();
    expect(label).toBe(trigger.getAttribute("title"));
  });

  it("インスペクタ開閉ボタンに title と同値の aria-label がある", () => {
    renderHeader();
    const btn = screen.getByTitle("インスペクター");
    expect(btn.getAttribute("aria-label")).toBe("インスペクター");
  });

  it("outline-none を使う要素は focus(-visible) ring の代替を持つ", () => {
    renderHeader();
    const targets = [
      ...document.querySelectorAll(
        "select, [data-testid='timeline-display-menu']",
      ),
    ];
    expect(targets.length).toBeGreaterThan(0);
    for (const el of targets) {
      const cls = el.className;
      if (cls.includes("outline-none")) {
        expect(cls).toContain("focus-visible:ring-1");
      }
    }
  });

  it("spacing select は reading モードで aria-disabled が立つ", () => {
    useTimelineStore.setState({ axisMode: "reading" });
    renderHeader();
    const select = screen.getByTestId("spacing-mode-select");
    expect(select.getAttribute("aria-disabled")).toBe("true");
  });
});
