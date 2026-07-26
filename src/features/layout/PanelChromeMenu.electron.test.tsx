// @vitest-environment happy-dom
/**
 * Electron シェルでの「別ウィンドウで開く」UI 発火（Phase 2 レビュー指摘修正）:
 * feature 層の表示ゲートが isTauri 単独だと Electron でメニュー項目が
 * 出ず、main 側 panelWindow ブリッジ（設計書 §6.5）へ到達不能になる
 * （受け入れ条件 A5）。ここでは項目表示と、クリック → panelWindow.ts →
 * webviewWindows.ts → bridge.panelWindow.open の renderer 側全連鎖を assert する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PanelChromeMenu } from "./PanelChromeMenu";
import { useLayoutStore } from "./layoutStore";

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => false) }));
vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
  isTauri: isTauriMock,
}));

type AnyWindow = Record<string, unknown>;

function installElectronBridge() {
  const panelWindow = {
    open: vi.fn().mockResolvedValue(undefined),
    focusByLabel: vi.fn().mockResolvedValue(false),
  };
  (window as unknown as AnyWindow).grimodex = {
    shell: "electron",
    invoke: vi.fn().mockResolvedValue({ ok: true, value: null }),
    listen: vi.fn().mockReturnValue(() => {}),
    emit: vi.fn().mockResolvedValue(undefined),
    panelWindow,
  };
  return panelWindow;
}

function setup(panelId: "scenes" | "editor" = "scenes") {
  useLayoutStore.setState({
    toggleMaximizePanel: vi.fn(),
    togglePanel: vi.fn(),
    maximizedPanelId: null,
  });
  return render(
    <PanelChromeMenu panelId={panelId}>
      <div>
        <div data-panel-header>
          <span data-testid="title">Scenes</span>
        </div>
      </div>
    </PanelChromeMenu>,
  );
}

beforeEach(() => {
  isTauriMock.mockReturnValue(false);
});

afterEach(() => {
  delete (window as unknown as AnyWindow).grimodex;
});

describe("PanelChromeMenu（Electron シェル）", () => {
  it("Electron では toggleable パネルに『別ウィンドウで開く』を出す", () => {
    installElectronBridge();
    const { getByTestId } = setup("scenes");
    fireEvent.contextMenu(getByTestId("title"));
    expect(screen.queryByTestId("panel-ctx-open-window-scenes")).not.toBeNull();
  });

  it("選択で bridge.panelWindow.open('panel-scenes', …) まで到達する", async () => {
    const panelWindow = installElectronBridge();
    const { getByTestId } = setup("scenes");
    const user = userEvent.setup();
    fireEvent.contextMenu(getByTestId("title"));
    await user.click(await screen.findByTestId("panel-ctx-open-window-scenes"));
    await vi.waitFor(() => {
      expect(panelWindow.open).toHaveBeenCalledWith(
        "panel-scenes",
        expect.objectContaining({ width: expect.any(Number) }),
      );
    });
    // 存在確認（focusByLabel=false）→ 新規 open の順で呼ばれている。
    expect(panelWindow.focusByLabel).toHaveBeenCalledWith("panel-scenes");
  });

  it("Electron でも editor には項目を出さない（複製窓防止）", () => {
    installElectronBridge();
    const { getByTestId } = setup("editor");
    fireEvent.contextMenu(getByTestId("title"));
    expect(screen.queryByTestId("panel-ctx-maximize-editor")).not.toBeNull();
    expect(screen.queryByTestId("panel-ctx-open-window-editor")).toBeNull();
  });

  it("plain browser（bridge 無し）では項目を出さない", () => {
    const { getByTestId } = setup("scenes");
    fireEvent.contextMenu(getByTestId("title"));
    expect(screen.queryByTestId("panel-ctx-maximize-scenes")).not.toBeNull();
    expect(screen.queryByTestId("panel-ctx-open-window-scenes")).toBeNull();
  });
});
