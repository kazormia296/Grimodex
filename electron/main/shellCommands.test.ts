/**
 * shellCommands の単体テスト（vitest node 環境 + electron モジュールモック）。
 * vibrancy 分岐 / license スタブ形状 / openExternal スキーム再検証 /
 * fs・zoom・windowControl の envelope 化を検証する。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Envelope } from "../shared/ipcContract.js";
import { IPC } from "../shared/ipcContract.js";

// ── electron モック（sandbox 外の node 環境では実 electron は import 不可） ──

const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>();

const openExternalMock = vi.fn(() => Promise.resolve());
const showOpenDialogMock = vi.fn();
const fromWebContentsMock = vi.fn();

vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.0-test" },
  dialog: { showOpenDialog: showOpenDialogMock },
  shell: { openExternal: openExternalMock },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  BrowserWindow: { fromWebContents: fromWebContentsMock },
}));

const { buildShellCommandHandlers, registerShellBridgeHandlers } = await import(
  "./shellCommands.js"
);

async function invokeBridge(
  channel: string,
  event: unknown,
  ...args: unknown[]
): Promise<Envelope> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return (await handler(event, ...args)) as Envelope;
}

beforeAll(() => {
  registerShellBridgeHandlers();
});

// ─────────────────────────────────────────────────────────────────────────────
// Tauri コマンド互換ハンドラ
// ─────────────────────────────────────────────────────────────────────────────

describe("buildShellCommandHandlers", () => {
  it("get_license_state は licensing 無効ビルドと同一形状（§4.3）", async () => {
    const h = buildShellCommandHandlers(null, "linux");
    await expect(h.get_license_state({})).resolves.toEqual({
      licensingEnabled: false,
      status: "disabled",
      trialDaysRemaining: null,
      graceDaysRemaining: null,
      keyTail: null,
      activatedAt: null,
      lastValidatedAt: null,
    });
  });

  it("set_window_vibrancy: darwin では setVibrancy を呼ぶ（Rust 実装と同分岐）", async () => {
    const setVibrancy = vi.fn();
    const h = buildShellCommandHandlers({ setVibrancy }, "darwin");
    await h.set_window_vibrancy({ enabled: true });
    expect(setVibrancy).toHaveBeenLastCalledWith("under-window");
    await h.set_window_vibrancy({ enabled: false });
    expect(setVibrancy).toHaveBeenLastCalledWith(null);
  });

  it("set_window_vibrancy: 非 darwin は no-op で成功する", async () => {
    const setVibrancy = vi.fn();
    const h = buildShellCommandHandlers({ setVibrancy }, "linux");
    await expect(h.set_window_vibrancy({ enabled: true })).resolves.toBeNull();
    expect(setVibrancy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ブリッジ native API
// ─────────────────────────────────────────────────────────────────────────────

describe("openExternal（scheme 再検証 = safeUrl.ts と二重防御）", () => {
  it("https は許可される", async () => {
    const env = await invokeBridge(
      IPC.openExternal,
      { sender: {} },
      "https://example.com/",
    );
    expect(env).toEqual({ ok: true, value: null });
    expect(openExternalMock).toHaveBeenCalledWith("https://example.com/");
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/plain,x"])(
    "%s は envelope エラーで拒否（shell.openExternal 不達）",
    async (url) => {
      openExternalMock.mockClear();
      const env = await invokeBridge(IPC.openExternal, { sender: {} }, url);
      expect(env.ok).toBe(false);
      if (!env.ok) expect(env.error).toContain("blocked external URL");
      expect(openExternalMock).not.toHaveBeenCalled();
    },
  );
});

describe("fs ブリッジ", () => {
  it("readTextFile / readDir が実ファイルを読める", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grim-shell-fs-"));
    try {
      writeFileSync(path.join(dir, "a.txt"), "こんにちは", "utf8");
      const text = await invokeBridge(
        IPC.fsReadTextFile,
        { sender: {} },
        path.join(dir, "a.txt"),
      );
      expect(text).toEqual({ ok: true, value: "こんにちは" });

      const listing = await invokeBridge(IPC.fsReadDir, { sender: {} }, dir);
      expect(listing).toEqual({
        ok: true,
        value: [
          { name: "a.txt", isDirectory: false, isFile: true, isSymlink: false },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("存在しないファイルはメッセージのみの envelope エラー（throw しない）", async () => {
    const env = await invokeBridge(
      IPC.fsReadTextFile,
      { sender: {} },
      "/no/such/file.txt",
    );
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error).toContain("ENOENT");
      expect(env.error.startsWith("Error:")).toBe(false);
    }
  });
});

describe("windowControl", () => {
  it("isMaximized は送信元窓の状態を返す", async () => {
    fromWebContentsMock.mockReturnValue({ isMaximized: () => true });
    const env = await invokeBridge(IPC.windowControl, { sender: {} }, "isMaximized");
    expect(env).toEqual({ ok: true, value: true });
  });

  it("toggleMaximize は最大化状態で unmaximize する", async () => {
    const unmaximize = vi.fn();
    const maximize = vi.fn();
    fromWebContentsMock.mockReturnValue({
      isMaximized: () => true,
      maximize,
      unmaximize,
    });
    const env = await invokeBridge(
      IPC.windowControl,
      { sender: {} },
      "toggleMaximize",
    );
    expect(env).toEqual({ ok: true, value: null });
    expect(unmaximize).toHaveBeenCalled();
    expect(maximize).not.toHaveBeenCalled();
  });

  it("窓が見つからない webContents は envelope エラー", async () => {
    fromWebContentsMock.mockReturnValue(null);
    const env = await invokeBridge(IPC.windowControl, { sender: {} }, "minimize");
    expect(env.ok).toBe(false);
  });

  it("未知の op は envelope エラー", async () => {
    fromWebContentsMock.mockReturnValue({ isMaximized: () => false });
    const env = await invokeBridge(IPC.windowControl, { sender: {} }, "destroy");
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error).toContain("unknown window control op");
  });
});

describe("setZoomFactor / getVersion / panelWindow スタブ", () => {
  it("zoom は main 側でクランプして sender に適用する", async () => {
    const setZoomFactor = vi.fn();
    const env = await invokeBridge(
      IPC.setZoomFactor,
      { sender: { setZoomFactor } },
      100,
    );
    expect(env).toEqual({ ok: true, value: null });
    expect(setZoomFactor).toHaveBeenCalledWith(4);
  });

  it("getVersion は app.getVersion() を返す", async () => {
    const env = await invokeBridge(IPC.getVersion, { sender: {} });
    expect(env).toEqual({ ok: true, value: "1.0.0-test" });
  });

  it("panelWindow は S7 まで IPC_UNIMPLEMENTED スタブ", async () => {
    const open = await invokeBridge(IPC.panelOpen, { sender: {} }, "panel-codex", {});
    expect(open).toEqual({
      ok: false,
      error: "IPC_UNIMPLEMENTED: panelWindow.open",
    });
    const focus = await invokeBridge(IPC.panelFocus, { sender: {} }, "panel-codex");
    expect(focus).toEqual({
      ok: false,
      error: "IPC_UNIMPLEMENTED: panelWindow.focusByLabel",
    });
  });
});
