// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { PanelChromeMenu, isPanelChromeGestureTarget } from "./PanelChromeMenu";
import { useLayoutStore } from "./layoutStore";

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => false) }));
vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
  isTauri: isTauriMock,
}));

function setup(panelId: "scenes" | "editor" = "scenes") {
  const toggleMaximizePanel = vi.fn();
  const togglePanel = vi.fn();
  useLayoutStore.setState({
    toggleMaximizePanel,
    togglePanel,
    maximizedPanelId: null,
  });
  const utils = render(
    <PanelChromeMenu panelId={panelId}>
      <div data-testid="panel-root">
        <div data-panel-header data-testid="header">
          <span data-testid="title">Scenes</span>
          <button type="button" data-testid="header-button">
            +
          </button>
          <div draggable data-testid="header-tab">
            tab
          </div>
        </div>
        <div data-testid="body">body</div>
      </div>
    </PanelChromeMenu>,
  );
  return { toggleMaximizePanel, togglePanel, ...utils };
}

describe("isPanelChromeGestureTarget", () => {
  it("ヘッダー内の非インタラクティブ要素のみ対象", () => {
    const { getByTestId } = setup();
    expect(isPanelChromeGestureTarget(getByTestId("title"))).toBe(true);
    expect(isPanelChromeGestureTarget(getByTestId("header"))).toBe(true);
    expect(isPanelChromeGestureTarget(getByTestId("header-button"))).toBe(
      false,
    );
    expect(isPanelChromeGestureTarget(getByTestId("body"))).toBe(false);
    expect(isPanelChromeGestureTarget(null)).toBe(false);
  });
});

describe("PanelChromeMenu", () => {
  it("ヘッダー空白部の dblclick で最大化をトグルする", () => {
    const { toggleMaximizePanel, getByTestId } = setup();
    fireEvent.doubleClick(getByTestId("title"));
    expect(toggleMaximizePanel).toHaveBeenCalledExactlyOnceWith("scenes");
  });

  it("ヘッダー内ボタン上の dblclick では発火しない", () => {
    const { toggleMaximizePanel, getByTestId } = setup();
    fireEvent.doubleClick(getByTestId("header-button"));
    expect(toggleMaximizePanel).not.toHaveBeenCalled();
  });

  it("draggable 要素（エディタのタブ等）上の dblclick では発火しない", () => {
    const { toggleMaximizePanel, getByTestId } = setup();
    fireEvent.doubleClick(getByTestId("header-tab"));
    expect(toggleMaximizePanel).not.toHaveBeenCalled();
  });

  it("パネル本体の dblclick では発火しない", () => {
    const { toggleMaximizePanel, getByTestId } = setup();
    fireEvent.doubleClick(getByTestId("body"));
    expect(toggleMaximizePanel).not.toHaveBeenCalled();
  });

  it("ヘッダー右クリックでメニューが開く", () => {
    const { getByTestId } = setup();
    fireEvent.contextMenu(getByTestId("title"));
    expect(screen.queryByTestId("panel-ctx-maximize-scenes")).not.toBeNull();
    expect(screen.queryByTestId("panel-ctx-collapse-scenes")).not.toBeNull();
  });

  it("パネル本体の右クリックではメニューを開かない", () => {
    const { getByTestId } = setup();
    fireEvent.contextMenu(getByTestId("body"));
    expect(screen.queryByTestId("panel-ctx-maximize-scenes")).toBeNull();
  });

  it("ヘッダー内ボタン上の右クリックではメニューを開かない", () => {
    const { getByTestId } = setup();
    fireEvent.contextMenu(getByTestId("header-button"));
    expect(screen.queryByTestId("panel-ctx-maximize-scenes")).toBeNull();
  });

  it("Tauri では toggleable パネルに『別ウィンドウで開く』を出す", () => {
    isTauriMock.mockReturnValue(true);
    const { getByTestId } = setup("scenes");
    fireEvent.contextMenu(getByTestId("title"));
    expect(screen.queryByTestId("panel-ctx-open-window-scenes")).not.toBeNull();
  });

  it("editor では『別ウィンドウで開く』を出さない(全アプリ窓の複製防止)", () => {
    isTauriMock.mockReturnValue(true);
    const { getByTestId } = setup("editor");
    fireEvent.contextMenu(getByTestId("title"));
    // メニュー自体は開く(最大化/折りたたみは出る)が、別窓項目は無い。
    expect(screen.queryByTestId("panel-ctx-maximize-editor")).not.toBeNull();
    expect(screen.queryByTestId("panel-ctx-open-window-editor")).toBeNull();
  });
});
