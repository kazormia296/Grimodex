/**
 * windows.ts のパネル別窓配線の単体テスト（設計書 §6.5、Phase 2 S7 —
 * label 検証 / URL は main が組み立て / 既存窓の focus 再利用 /
 * メイン窓 closed で全パネル窓 close。vitest node 環境 + electron モック）。
 *
 * registry / window-state store は windows.ts のモジュール状態のため、
 * このファイル内の it は上から順に 1 本のライフサイクルとして進む。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IPC } from "../shared/ipcContract.js";

// ── electron モック ──────────────────────────────────────────────────────────

const userDataDir = mkdtempSync(path.join(os.tmpdir(), "grim-windows-panel-"));

let nextWebContentsId = 1;

type Handler = (...args: unknown[]) => void;

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = [];

  options: Record<string, unknown>;
  loadedUrl: string | null = null;
  destroyed = false;
  minimized = false;
  fullScreen = false;

  focus = vi.fn();
  show = vi.fn();
  maximize = vi.fn();
  setFullScreen = vi.fn((active: boolean) => {
    this.fullScreen = active;
  });
  setPosition = vi.fn();
  restore = vi.fn(() => {
    this.minimized = false;
  });
  loadURL = vi.fn((url: string) => {
    this.loadedUrl = url;
    return Promise.resolve();
  });

  webContents = {
    id: nextWebContentsId++,
    send: vi.fn(),
    on: vi.fn(),
    getURL: () => this.loadedUrl ?? "",
  };

  private handlers = new Map<string, Handler[]>();
  private onceHandlers = new Map<string, Handler[]>();

  constructor(options: Record<string, unknown>) {
    this.options = options;
    FakeBrowserWindow.instances.push(this);
  }

  on(event: string, fn: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }

  once(event: string, fn: Handler): this {
    const list = this.onceHandlers.get(event) ?? [];
    list.push(fn);
    this.onceHandlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    const onceList = this.onceHandlers.get(event) ?? [];
    this.onceHandlers.delete(event);
    for (const fn of onceList) fn(...args);
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }

  /** 実 BrowserWindow の close 契約の近似: close → (veto なしなら) closed。 */
  close = vi.fn(() => {
    let prevented = false;
    this.emit("close", {
      preventDefault: () => {
        prevented = true;
      },
    });
    if (!prevented) {
      this.destroyed = true;
      this.emit("closed");
    }
  });

  isDestroyed(): boolean {
    return this.destroyed;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  isMaximized(): boolean {
    return false;
  }
  isFullScreen(): boolean {
    return this.fullScreen;
  }
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 480, height: 900 };
  }
  getNormalBounds(): { x: number; y: number; width: number; height: number } {
    return this.getBounds();
  }
}

vi.mock("electron", () => ({
  app: {
    getPath: () => userDataDir,
    on: vi.fn(),
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: { on: vi.fn() },
  Menu: {
    setApplicationMenu: vi.fn(),
    buildFromTemplate: vi.fn(),
  },
  screen: {
    getAllDisplays: () => [
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    ],
  },
}));

const { createMainWindow, focusPanelWindow, openPanelWindow } =
  await import("./windows.js");

const savedRendererUrl = process.env.ELECTRON_RENDERER_URL;

beforeAll(() => {
  process.env.ELECTRON_RENDERER_URL = "http://localhost:1430";
});

afterAll(() => {
  if (savedRendererUrl === undefined) {
    delete process.env.ELECTRON_RENDERER_URL;
  } else {
    process.env.ELECTRON_RENDERER_URL = savedRendererUrl;
  }
  rmSync(userDataDir, { recursive: true, force: true });
});

function panelInstances(): FakeBrowserWindow[] {
  return FakeBrowserWindow.instances.filter((w) =>
    String(w.loadedUrl).includes("window=panel"),
  );
}

describe("openPanelWindow / focusPanelWindow（§6.5）", () => {
  it("不正 label は throw する（envelope エラーに畳まれる契約）", () => {
    expect(() => openPanelWindow("main", {})).toThrow(
      /invalid panel window label/,
    );
    expect(() => openPanelWindow("panel-Codex?x=1", {})).toThrow(
      /invalid panel window label/,
    );
    expect(FakeBrowserWindow.instances).toHaveLength(0);
  });

  it("生成: URL は main が label から組み立てる（renderer 供給 URL なし）", () => {
    openPanelWindow("panel-codex", {
      width: 500,
      height: 700,
      title: "Codex",
    });

    expect(FakeBrowserWindow.instances).toHaveLength(1);
    const win = FakeBrowserWindow.instances[0];
    expect(win.loadURL).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:1430/?window=panel&panel=codex",
    );
    expect(win.options.frame).toBe(false);
    expect(win.options.resizable).toBe(true);
    expect(win.options.transparent).toBe(false);
    expect(win.options.width).toBe(500);
    expect(win.options.height).toBe(700);
    const webPreferences = win.options.webPreferences as Record<
      string,
      unknown
    >;
    expect(webPreferences.contextIsolation).toBe(true);
    expect(webPreferences.sandbox).toBe(true);
    expect(webPreferences.nodeIntegration).toBe(false);
  });

  it("ready-to-show が来なくても did-finish-load で窓を表示する", () => {
    const win = FakeBrowserWindow.instances[0];
    expect(win.show).not.toHaveBeenCalled();

    const didFinishLoad = win.webContents.on.mock.calls.find(
      ([event]) => event === "did-finish-load",
    )?.[1] as (() => void) | undefined;
    expect(didFinishLoad).toBeTypeOf("function");
    didFinishLoad?.();
    expect(win.show).toHaveBeenCalledTimes(1);

    // 遅れて ready-to-show が届いても二重表示しない。
    win.emit("ready-to-show");
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it("同一 label の再 open は新窓を作らず focus する（冪等）", () => {
    const win = FakeBrowserWindow.instances[0];
    win.minimized = true;

    openPanelWindow("panel-codex", { width: 480, height: 900, title: "Codex" });

    expect(FakeBrowserWindow.instances).toHaveLength(1);
    expect(win.restore).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });

  it("focusPanelWindow: 生存窓は focus して true、未知/不正 label は false", () => {
    const win = FakeBrowserWindow.instances[0];
    win.focus.mockClear();

    expect(focusPanelWindow("panel-codex")).toBe(true);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(focusPanelWindow("panel-missing")).toBe(false);
    expect(focusPanelWindow("not-a-panel")).toBe(false);
  });

  it("native fullscreen の出入りも renderer へ状態再取得通知を送る", () => {
    const win = FakeBrowserWindow.instances[0];
    win.webContents.send.mockClear();

    win.emit("enter-full-screen");
    win.emit("leave-full-screen");

    expect(win.webContents.send).toHaveBeenNthCalledWith(1, IPC.windowResized);
    expect(win.webContents.send).toHaveBeenNthCalledWith(2, IPC.windowResized);
  });

  it("plain F11 keydown は現在のアプリ窓の fullscreen を切り替える", () => {
    const win = FakeBrowserWindow.instances[0];
    const beforeInput = win.webContents.on.mock.calls.find(
      ([event]) => event === "before-input-event",
    )?.[1] as
      | ((
          event: { preventDefault: () => void },
          input: Record<string, unknown>,
        ) => void)
      | undefined;
    expect(beforeInput).toBeTypeOf("function");

    const enterEvent = { preventDefault: vi.fn() };
    beforeInput?.(enterEvent, {
      type: "keyDown",
      key: "F11",
      code: "F11",
      isAutoRepeat: false,
      shift: false,
      control: false,
      alt: false,
      meta: false,
    });
    expect(enterEvent.preventDefault).toHaveBeenCalledOnce();
    expect(win.setFullScreen).toHaveBeenLastCalledWith(true);

    const leaveEvent = { preventDefault: vi.fn() };
    beforeInput?.(leaveEvent, {
      type: "keyDown",
      key: "F11",
      code: "F11",
      isAutoRepeat: false,
      shift: false,
      control: false,
      alt: false,
      meta: false,
    });
    expect(leaveEvent.preventDefault).toHaveBeenCalledOnce();
    expect(win.setFullScreen).toHaveBeenLastCalledWith(false);
  });

  it.each([
    ["keyup", { type: "keyUp", isAutoRepeat: false }],
    ["キーリピート", { type: "keyDown", isAutoRepeat: true }],
  ])("plain F11 の %s は消費するが再切替しない", (_label, overrides) => {
    const win = FakeBrowserWindow.instances[0];
    const beforeInput = win.webContents.on.mock.calls.find(
      ([event]) => event === "before-input-event",
    )?.[1] as
      | ((
          event: { preventDefault: () => void },
          input: Record<string, unknown>,
        ) => void)
      | undefined;
    expect(beforeInput).toBeTypeOf("function");

    win.setFullScreen.mockClear();
    const event = { preventDefault: vi.fn() };
    beforeInput?.(
      event,
      Object.assign(
        {
          type: "keyDown",
          key: "F11",
          code: "F11",
          isAutoRepeat: false,
          shift: false,
          control: false,
          alt: false,
          meta: false,
        },
        overrides,
      ),
    );

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(win.setFullScreen).not.toHaveBeenCalled();
  });

  it.each([
    ["別キー", { key: "F10", code: "F10" }],
    ["修飾付き", { control: true }],
  ])("%s は fullscreen shortcut として扱わない", (_label, overrides) => {
    const win = FakeBrowserWindow.instances[0];
    const beforeInput = win.webContents.on.mock.calls.find(
      ([event]) => event === "before-input-event",
    )?.[1] as
      | ((
          event: { preventDefault: () => void },
          input: Record<string, unknown>,
        ) => void)
      | undefined;
    expect(beforeInput).toBeTypeOf("function");

    win.setFullScreen.mockClear();
    const event = { preventDefault: vi.fn() };
    beforeInput?.(event, {
      type: "keyDown",
      key: "F11",
      code: "F11",
      isAutoRepeat: false,
      shift: false,
      control: false,
      alt: false,
      meta: false,
      ...overrides,
    });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(win.setFullScreen).not.toHaveBeenCalled();
  });

  it("メイン窓 closed で全パネル窓へ close が伝播し、registry から消える", () => {
    const main = createMainWindow() as unknown as FakeBrowserWindow;
    const panel = panelInstances()[0];
    expect(panel.destroyed).toBe(false);

    // 実 Electron では win.close() → close イベント（veto 問い合わせ）→ closed。
    // ハンドラ未登録の窓は即 close（§6.4 手順 4）なので fake は closed まで進む。
    main.destroyed = true;
    main.emit("closed");

    expect(panel.close).toHaveBeenCalled();
    expect(panel.destroyed).toBe(true);
    expect(focusPanelWindow("panel-codex")).toBe(false);
  });
});
