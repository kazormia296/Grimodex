// @vitest-environment happy-dom
/**
 * Electron シェルでのパネル別窓ゲート（Phase 2 レビュー指摘修正）:
 * openPanelWindow / getPanelWindowHandle の実行可否は isTauri 単独ではなく
 * supportsPanelWindows（= isTauri || isElectron）で判定する。
 * これが欠けると main 側 panelWindow ブリッジ（設計書 §6.5）が
 * renderer から一切呼ばれない dead code になる（受け入れ条件 A5）。
 *
 * isTauri / isElectron は mock せず実体を使い、window への
 * `__TAURI_INTERNALS__` / `grimodex` 注入で環境を切り替える
 * （src/lib/tauri.electron.test.ts と同じ作法）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getByLabelMock, setFocusMock, ctorSpy } = vi.hoisted(() => ({
  getByLabelMock: vi.fn(),
  setFocusMock: vi.fn(),
  ctorSpy: vi.fn(),
}));
vi.mock("@/lib/webviewWindows", () => ({
  getWebviewWindowByLabel: getByLabelMock,
  createWebviewWindow: (label: string, options: Record<string, unknown>) =>
    ctorSpy(label, options),
}));

import {
  openPanelWindow,
  getPanelWindowHandle,
  supportsPanelWindows,
} from "./panelWindow";

type AnyWindow = Record<string, unknown>;

function installElectronBridge() {
  (window as unknown as AnyWindow).grimodex = { shell: "electron" };
}

beforeEach(() => {
  getByLabelMock.mockReset();
  setFocusMock.mockReset();
  ctorSpy.mockReset();
});

afterEach(() => {
  delete (window as unknown as AnyWindow).__TAURI_INTERNALS__;
  delete (window as unknown as AnyWindow).grimodex;
});

describe("supportsPanelWindows", () => {
  it("plain browser（Tauri でも Electron でもない）は false", () => {
    expect(supportsPanelWindows()).toBe(false);
  });
  it("Tauri（__TAURI_INTERNALS__ あり）は true", () => {
    (window as unknown as AnyWindow).__TAURI_INTERNALS__ = {};
    expect(supportsPanelWindows()).toBe(true);
  });
  it("Electron（window.grimodex あり）は true", () => {
    installElectronBridge();
    expect(supportsPanelWindows()).toBe(true);
  });
});

describe("openPanelWindow（Electron シェル）", () => {
  it("別窓が無ければ panel-<id> label で生成する（no-op にならない）", async () => {
    installElectronBridge();
    getByLabelMock.mockResolvedValue(null);
    await openPanelWindow("codex");
    expect(ctorSpy).toHaveBeenCalledTimes(1);
    const [label, options] = ctorSpy.mock.calls[0];
    expect(label).toBe("panel-codex");
    expect(options.url).toContain("panel=codex");
  });

  it("既存窓があれば focus・新規生成しない", async () => {
    installElectronBridge();
    getByLabelMock.mockResolvedValue({ setFocus: setFocusMock });
    await openPanelWindow("codex");
    expect(setFocusMock).toHaveBeenCalled();
    expect(ctorSpy).not.toHaveBeenCalled();
  });

  it("editor は Electron でも no-op（全アプリ窓の複製防止）", async () => {
    installElectronBridge();
    getByLabelMock.mockResolvedValue(null);
    await openPanelWindow("editor");
    expect(getByLabelMock).not.toHaveBeenCalled();
    expect(ctorSpy).not.toHaveBeenCalled();
  });

  it("plain browser は従来どおり no-op", async () => {
    await openPanelWindow("codex");
    expect(getByLabelMock).not.toHaveBeenCalled();
    expect(ctorSpy).not.toHaveBeenCalled();
  });
});

describe("getPanelWindowHandle（Electron シェル）", () => {
  it("Electron では label 検索へ委譲する（常時 null にならない）", async () => {
    installElectronBridge();
    const handle = { setFocus: setFocusMock };
    getByLabelMock.mockResolvedValue(handle);
    await expect(getPanelWindowHandle("codex")).resolves.toBe(handle);
    expect(getByLabelMock).toHaveBeenCalledWith("panel-codex");
  });

  it("plain browser は null（検索もしない）", async () => {
    await expect(getPanelWindowHandle("codex")).resolves.toBeNull();
    expect(getByLabelMock).not.toHaveBeenCalled();
  });
});
