// @vitest-environment happy-dom
/**
 * webviewWindows の Electron 分岐（設計書 §6.5）:
 * getWebviewWindowByLabel は focusByLabel を存在確認に使い、
 * createWebviewWindow は width/height/title のみを main に渡す
 * （URL は main が label から組み立てる — renderer 供給 URL を渡さない）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createWebviewWindow, getWebviewWindowByLabel } from "./webviewWindows";

function installBridge(focusResult: boolean) {
  const panelWindow = {
    open: vi.fn().mockResolvedValue(undefined),
    focusByLabel: vi.fn().mockResolvedValue(focusResult),
  };
  (window as unknown as Record<string, unknown>).grimodex = {
    shell: "electron",
    panelWindow,
  };
  return panelWindow;
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("getWebviewWindowByLabel electron 分岐", () => {
  it("窓が在れば handle を返し、setFocus は focusByLabel を再度呼ぶ", async () => {
    const panelWindow = installBridge(true);
    const handle = await getWebviewWindowByLabel("panel-codex");
    expect(handle).not.toBeNull();
    expect(panelWindow.focusByLabel).toHaveBeenCalledWith("panel-codex");
    await handle!.setFocus();
    expect(panelWindow.focusByLabel).toHaveBeenCalledTimes(2);
  });

  it("窓が無ければ null", async () => {
    installBridge(false);
    await expect(getWebviewWindowByLabel("panel-codex")).resolves.toBeNull();
  });
});

describe("createWebviewWindow electron 分岐", () => {
  it("panelWindow.open に width/height/title のみ渡す（URL は渡さない）", async () => {
    const panelWindow = installBridge(false);
    await createWebviewWindow("panel-codex", {
      url: "index.html?window=panel&panel=codex",
      transparent: true,
      decorations: false,
      width: 480,
      height: 900,
      title: "Codex",
    });
    expect(panelWindow.open).toHaveBeenCalledWith("panel-codex", {
      width: 480,
      height: 900,
      title: "Codex",
    });
  });
});
