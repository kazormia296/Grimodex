// @vitest-environment happy-dom
/**
 * webviewWindows の Electron 分岐（設計書 §6.5）:
 * getWebviewWindowByLabel は read-only existence probe を使い、
 * createWebviewWindow は width/height/title のみを main に渡す
 * （URL は main が label から組み立てる — renderer 供給 URL を渡さない）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createWebviewWindow, getWebviewWindowByLabel } from "./webviewWindows";

function installBridge(existsResult: boolean) {
  const panelWindow = {
    open: vi.fn().mockResolvedValue(undefined),
    focusByLabel: vi.fn().mockResolvedValue(existsResult),
    existsByLabel: vi.fn().mockResolvedValue(existsResult),
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
  it("窓が在れば focus せず handle を返し、setFocus だけが focus する", async () => {
    const panelWindow = installBridge(true);
    const handle = await getWebviewWindowByLabel("panel-codex");
    expect(handle).not.toBeNull();
    expect(panelWindow.existsByLabel).toHaveBeenCalledWith("panel-codex");
    expect(panelWindow.focusByLabel).not.toHaveBeenCalled();
    await handle!.setFocus();
    expect(panelWindow.focusByLabel).toHaveBeenCalledOnce();
  });

  it("窓が無ければ null", async () => {
    const panelWindow = installBridge(false);
    await expect(getWebviewWindowByLabel("panel-codex")).resolves.toBeNull();
    expect(panelWindow.focusByLabel).not.toHaveBeenCalled();
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
