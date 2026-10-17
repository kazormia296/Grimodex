/**
 * windows.ts の窓の title の固定と、packaged build の読込先の単体テスト
 * （K3/2 行 18、Negative (28) の一部、「renderer の隔離」(e)。DA-1）。
 * vitest node 環境 + electron モック。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const userDataDir = mkdtempSync(path.join(os.tmpdir(), "grim-windows-title-"));

const { appState } = vi.hoisted(() => ({ appState: { isPackaged: false } }));

type Handler = (...args: unknown[]) => void;

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = [];
  options: Record<string, unknown>;
  loadedUrl: string | null = null;
  destroyed = false;
  title: string;
  handlers = new Map<string, Handler[]>();
  loadURL = vi.fn((url: string) => {
    this.loadedUrl = url;
    return Promise.resolve();
  });
  setTitle = vi.fn((title: string) => {
    this.title = title;
  });
  webContents = {
    id: FakeBrowserWindow.instances.length + 1,
    send: vi.fn(),
    on: vi.fn(),
    getURL: () => this.loadedUrl ?? "",
  };
  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.title = typeof options.title === "string" ? options.title : "Grimodex";
    FakeBrowserWindow.instances.push(this);
  }
  on(event: string, fn: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }
  once(event: string, fn: Handler): this {
    return this.on(event, fn);
  }
  /** document.title の変更を模す。`preventDefault` されなければ窓の title が変わる。 */
  documentTitleChanged(next: string): boolean {
    let prevented = false;
    const event = {
      preventDefault: () => {
        prevented = true;
      },
    };
    for (const fn of this.handlers.get("page-title-updated") ?? []) {
      fn(event, next, true);
    }
    if (!prevented) this.title = next;
    return prevented;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isMinimized(): boolean {
    return false;
  }
  isMaximized(): boolean {
    return false;
  }
  isFullScreen(): boolean {
    return false;
  }
  getBounds() {
    return { x: 0, y: 0, width: 480, height: 900 };
  }
  getNormalBounds() {
    return this.getBounds();
  }
  focus = vi.fn();
  restore = vi.fn();
  close = vi.fn();
}

vi.mock("electron", () => ({
  app: {
    getPath: () => userDataDir,
    on: vi.fn(),
    get isPackaged() {
      return appState.isPackaged;
    },
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: { on: vi.fn() },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
  screen: {
    getAllDisplays: () => [
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    ],
  },
}));

const {
  createMainWindow,
  getWindow,
  openPanelWindow,
  resetWindowTitles,
  setWindowTitleLock,
} = await import("./windows.js");

afterAll(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe("窓の title の固定（restricted または unavailable）", () => {
  let locked = false;
  let main: FakeBrowserWindow;
  let panel: FakeBrowserWindow;

  beforeEach(() => {
    if (!main) {
      locked = false;
      setWindowTitleLock(() => locked);
      createMainWindow();
      openPanelWindow("panel-codex", { title: "Codex" });
      main = FakeBrowserWindow.instances[0];
      panel = FakeBrowserWindow.instances[1];
    }
    locked = false;
    main.title = "Grimodex";
    panel.title = "Codex";
  });

  it("unrestricted: document.title の変更は窓の title に反映される（挙動を変えない）", () => {
    expect(main.documentTitleChanged("Chapter 3")).toBe(false);
    expect(main.title).toBe("Chapter 3");
    expect(panel.documentTitleChanged("x")).toBe(false);
    expect(panel.title).toBe("x");
  });

  it("restricted または unavailable: page-title-updated を取り消し、窓の title は製品名のまま", () => {
    locked = true;
    expect(main.documentTitleChanged("secret chapter text")).toBe(true);
    expect(main.title).toBe("Grimodex");
    expect(panel.documentTitleChanged("secret")).toBe(true);
    expect(panel.title).toBe("Codex");
  });

  it("gate の状態は変更のたびに読む（固定の前後で効く）", () => {
    expect(main.documentTitleChanged("a")).toBe(false);
    locked = true;
    expect(main.documentTitleChanged("b")).toBe(true);
    locked = false;
    expect(main.documentTitleChanged("c")).toBe(false);
    expect(main.title).toBe("c");
  });

  it("resetWindowTitles: 全窓の title を生成時の値に戻す（呼出しは DA-2 の段 2）", () => {
    main.title = "leaked before activation";
    panel.title = "leaked panel";
    resetWindowTitles();
    expect(main.setTitle).toHaveBeenLastCalledWith("Grimodex");
    expect(panel.setTitle).toHaveBeenLastCalledWith("Codex");
    expect(main.title).toBe("Grimodex");
    expect(panel.title).toBe("Codex");
  });

  it("resetWindowTitles: 破棄済みの窓は触らない", () => {
    panel.destroyed = true;
    panel.setTitle.mockClear();
    resetWindowTitles();
    expect(panel.setTitle).not.toHaveBeenCalled();
    panel.destroyed = false;
  });

  it("供給されない間は固定する側（fail closed）", () => {
    setWindowTitleLock(null);
    expect(main.documentTitleChanged("x")).toBe(true);
    setWindowTitleLock(() => locked);
  });

  it("getWindow は生成した窓を返す", () => {
    expect(getWindow("main")).toBe(main);
  });
});

describe("packaged build は ELECTRON_RENDERER_URL を無視する", () => {
  const saved = process.env.ELECTRON_RENDERER_URL;

  afterAll(() => {
    if (saved === undefined) delete process.env.ELECTRON_RENDERER_URL;
    else process.env.ELECTRON_RENDERER_URL = saved;
    appState.isPackaged = false;
  });

  it("packaged: env に dev server があってもメイン窓は production の app://bundle/index.html を読む", () => {
    // 既存のメイン窓を閉じて registry から外し、作り直す。
    const first = getWindow("main") as unknown as FakeBrowserWindow;
    first.destroyed = true;
    for (const fn of first.handlers.get("closed") ?? []) fn();
    process.env.ELECTRON_RENDERER_URL = "http://localhost:1430";
    appState.isPackaged = true;
    createMainWindow();
    const win = FakeBrowserWindow.instances.at(-1)!;
    expect(win).not.toBe(first);
    expect(win.loadURL).toHaveBeenCalledExactlyOnceWith(
      "app://bundle/index.html",
    );
  });

  it("非 packaged: メイン窓は dev server の URL を読む", () => {
    const first = getWindow("main") as unknown as FakeBrowserWindow;
    first.destroyed = true;
    for (const fn of first.handlers.get("closed") ?? []) fn();
    process.env.ELECTRON_RENDERER_URL = "http://localhost:1430";
    appState.isPackaged = false;
    createMainWindow();
    const win = FakeBrowserWindow.instances.at(-1)!;
    expect(win.loadURL).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:1430",
    );
  });

  it("packaged: env に dev server があっても panel 窓は production の app://bundle を読む", () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:1430";
    appState.isPackaged = true;
    openPanelWindow("panel-chat", {});
    const win = FakeBrowserWindow.instances.at(-1)!;
    expect(win.loadURL).toHaveBeenCalledExactlyOnceWith(
      "app://bundle/index.html?window=panel&panel=chat",
    );
  });

  it("非 packaged: dev server の URL を読む（dev と journey の起動は変えない）", () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:1430";
    appState.isPackaged = false;
    openPanelWindow("panel-map", {});
    const win = FakeBrowserWindow.instances.at(-1)!;
    expect(win.loadURL).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:1430/?window=panel&panel=map",
    );
  });
});
