// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KouetsuPanel } from "./KouetsuPanel";
import { useKouetsuStore } from "./kouetsuStore";

vi.mock("./IssuesInbox", () => ({
  IssuesInbox: () => <div data-testid="stub-issues" />,
}));
vi.mock("./CommentsTab", () => ({
  CommentsTab: () => <div data-testid="stub-comments" />,
}));
vi.mock("./BlockerTab", () => ({
  BlockerTab: () => <div data-testid="stub-blocker" />,
}));

describe("KouetsuPanel タブの ARIA tablist パターン", () => {
  beforeEach(() => {
    useKouetsuStore.setState({ activeTab: "issues", panelActive: true });
  });

  it("tablist/tab/tabpanel のロールと aria-selected を持つ", () => {
    render(<KouetsuPanel />);
    const tablist = screen.getByRole("tablist");
    expect(tablist).toHaveAccessibleName();

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    for (const tab of tabs.slice(1)) {
      expect(tab).toHaveAttribute("aria-selected", "false");
    }

    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].id);
    for (const tab of tabs) {
      expect(tab.getAttribute("aria-controls")).toBe(panel.id);
    }
  });

  it("roving tabindex: 選択タブのみ tabIndex=0", () => {
    render(<KouetsuPanel />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0].tabIndex).toBe(0);
    for (const tab of tabs.slice(1)) {
      expect(tab.tabIndex).toBe(-1);
    }

    fireEvent.click(tabs[1]);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1].tabIndex).toBe(0);
    expect(tabs[0].tabIndex).toBe(-1);
    expect(screen.getByTestId("stub-comments")).toBeInTheDocument();
  });

  it("ArrowRight で次のタブへ選択とフォーカスが移る（末尾から先頭へ循環）", () => {
    render(<KouetsuPanel />);
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();

    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tabs[1]);
    expect(screen.getByTestId("stub-comments")).toBeInTheDocument();

    fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
    expect(tabs[2]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("stub-blocker")).toBeInTheDocument();

    fireEvent.keyDown(tabs[2], { key: "ArrowRight" });
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tabs[0]);
  });

  it("ArrowLeft で前のタブへ（先頭から末尾へ循環）、Home/End で端へ", () => {
    render(<KouetsuPanel />);
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();

    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(tabs[2]).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tabs[2]);
    expect(screen.getByTestId("stub-blocker")).toBeInTheDocument();

    fireEvent.keyDown(tabs[2], { key: "Home" });
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tabs[0]);

    fireEvent.keyDown(tabs[0], { key: "End" });
    expect(tabs[2]).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tabs[2]);
  });

  it("タブパネルの aria-labelledby は選択タブに追従する", () => {
    render(<KouetsuPanel />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.click(tabs[1]);
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[1].id);
  });

  it("タブボタンに focus-visible スタイルを持つ（2.4.7 Focus Visible 回帰ガード）", () => {
    render(<KouetsuPanel />);
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toContain("focus-visible:ring-1");
      expect(tab.className).toContain("focus-visible:ring-ring");
    }
  });

  it("persist 済みの旧タブ値 editorial は issues へ正規化される", () => {
    useKouetsuStore.setState({ activeTab: "editorial" as never });
    render(<KouetsuPanel />);
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("stub-issues")).toBeInTheDocument();
  });

  it("パネルヘッダは data-panel-header を持つ（PanelHeader 正本）", () => {
    const { container } = render(<KouetsuPanel />);
    expect(container.querySelector("[data-panel-header]")).not.toBeNull();
    expect(container.querySelectorAll("[data-panel-header]")).toHaveLength(1);
  });
});
