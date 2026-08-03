// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import {
  ChronicleToolbar,
  type ChronicleToolbarProps,
} from "./ChronicleToolbar";

function makeProps(
  over: Partial<ChronicleToolbarProps> = {},
): ChronicleToolbarProps {
  return {
    issueCount: 0,
    showLegend: false,
    showEventList: false,
    showInspector: false,
    showEdges: true,
    density: "standard" as const,
    labelsOn: true,
    locked: false,
    calendar: null,
    creating: false,
    onNew: vi.fn(),
    onExtract: vi.fn(),
    onSaveCalendar: vi.fn(),
    onToggleLock: vi.fn(),
    onGotoConflict: vi.fn(),
    onToggleEdges: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onFit: vi.fn(),
    onToggleLegend: vi.fn(),
    onToggleEventList: vi.fn(),
    onToggleInspector: vi.fn(),
    onSetDensity: vi.fn(),
    onToggleLabels: vi.fn(),
    ...over,
  };
}

describe("ChronicleToolbar", () => {
  it("密度ボタンにアイコンが付く（従来テキストのみ→アイコン追加）", () => {
    const { getByTestId } = render(<ChronicleToolbar {...makeProps()} />);
    expect(getByTestId("toolbar-density").querySelector("svg")).toBeTruthy();
  });

  it("凡例ボタンにアイコンが付く（従来テキストのみ→アイコン追加）", () => {
    const { getByTestId } = render(<ChronicleToolbar {...makeProps()} />);
    expect(getByTestId("toolbar-legend").querySelector("svg")).toBeTruthy();
  });

  it("アイコンのみ縮退でも分かるよう主要ボタンに title を付ける", () => {
    const { getByTestId } = render(<ChronicleToolbar {...makeProps()} />);
    expect(getByTestId("toolbar-new").getAttribute("title")).toBeTruthy();
    expect(getByTestId("toolbar-density").getAttribute("title")).toBeTruthy();
    expect(getByTestId("toolbar-legend").getAttribute("title")).toBeTruthy();
  });

  it("ラベルは narrow で畳めるよう collapse クラス付き span に包む", () => {
    const { getByTestId } = render(<ChronicleToolbar {...makeProps()} />);
    // 密度ボタン内の最初の span がラベル。@container の max 幅変種で畳む。
    const span = getByTestId("toolbar-density").querySelector("span");
    expect(span?.className).toContain("@max-");
  });

  it("ツールバー行が @container（コンテナクエリの基準）", () => {
    const { getByTestId } = render(<ChronicleToolbar {...makeProps()} />);
    // 行 = new ボタンの祖先。@container クラスを持つ。
    const row = getByTestId("toolbar-new").parentElement as HTMLElement;
    expect(row.className).toContain("@container");
  });

  it("Glass ホストを覆う不透明なカード塗りを持たない", () => {
    const { getByTestId } = render(<ChronicleToolbar {...makeProps()} />);
    expect(getByTestId("chronicle-toolbar").className).not.toContain("bg-card");
  });
});
