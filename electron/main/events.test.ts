/**
 * EventBus の単体テスト（設計書 §7.1 / §8 S7 — allowlist 拒否 / 全窓
 * broadcast / 自己配信、napi TSFn 配線の検証。vitest node 環境 +
 * electron モジュールモック）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC } from "../shared/ipcContract.js";
import type { NapiBackendLike } from "../shared/ipcContract.js";

// ── electron モック ──────────────────────────────────────────────────────────

type EmitHandler = (event: unknown, channel: unknown, payload: unknown) => void;

const ipcMainHandlers = new Map<string, EmitHandler>();

interface FakeWindow {
  destroyed: boolean;
  isDestroyed(): boolean;
  webContents: { id: number; send: ReturnType<typeof vi.fn> };
}

const allWindows: FakeWindow[] = [];

function makeWindow(id: number): FakeWindow {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: { id, send: vi.fn() },
  };
}

vi.mock("electron", () => ({
  ipcMain: {
    on: (channel: string, fn: EmitHandler) => {
      ipcMainHandlers.set(channel, fn);
    },
  },
  BrowserWindow: {
    getAllWindows: () => allWindows,
  },
}));

const {
  broadcastBackendEvent,
  broadcastEvent,
  broadcastMainEvent,
  registerEventBus,
  sendBackendEventToWindow,
  sendMainEventToWindow,
} = await import("./events.js");

function makeBackend(): NapiBackendLike & {
  capturedCallback: ((...args: unknown[]) => unknown) | null;
} {
  const backend = {
    capturedCallback: null as ((...args: unknown[]) => unknown) | null,
    dbExecute: vi.fn(),
    dbExecuteBatch: vi.fn(),
    openWorkspace: vi.fn(),
    validateWorkspacePath: vi.fn(),
    getGlobalSettings: vi.fn(),
    saveGlobalSettings: vi.fn(),
    timelapseAppendBatch: vi.fn(),
    onEvent(callback: (...args: unknown[]) => unknown) {
      backend.capturedCallback = callback;
    },
  };
  return backend as typeof backend & NapiBackendLike;
}

function emitFromRenderer(
  senderWin: FakeWindow,
  channel: unknown,
  payload: unknown,
): void {
  const handler = ipcMainHandlers.get(IPC.emit);
  if (!handler) throw new Error("grim:emit handler not registered");
  handler({ sender: senderWin.webContents }, channel, payload);
}

beforeEach(() => {
  ipcMainHandlers.clear();
  allWindows.length = 0;
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// broadcastEvent
// ─────────────────────────────────────────────────────────────────────────────

describe("broadcastEvent", () => {
  it("全窓の webContents へ grim:event 1 本で配信する", () => {
    const w1 = makeWindow(1);
    const w2 = makeWindow(2);
    allWindows.push(w1, w2);

    broadcastEvent("codex:data-changed", { projectId: "p1" });

    for (const w of [w1, w2]) {
      expect(w.webContents.send).toHaveBeenCalledExactlyOnceWith(
        IPC.event,
        "codex:data-changed",
        { projectId: "p1" },
      );
    }
  });

  it("破棄済みの窓はスキップする", () => {
    const alive = makeWindow(1);
    const dead = makeWindow(2);
    dead.destroyed = true;
    allWindows.push(alive, dead);

    broadcastEvent("codex:lock-event", { kind: "release" });

    expect(alive.webContents.send).toHaveBeenCalledTimes(1);
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderer 発 emit（grim:emit → allowlist 検証 → 全窓 broadcast）
// ─────────────────────────────────────────────────────────────────────────────

describe("registerEventBus: renderer 発 emit", () => {
  it("allowlist 内チャネルは送信元窓を含む全窓へ配信する（Tauri v2 の自己配信契約）", () => {
    registerEventBus(null);
    const sender = makeWindow(1);
    const other = makeWindow(2);
    allWindows.push(sender, other);

    emitFromRenderer(sender, "codex:data-changed", { projectId: "p1" });

    // 自己配信: 送信元の窓にも届く（codexWindowSync のロック収束が依存）
    expect(sender.webContents.send).toHaveBeenCalledExactlyOnceWith(
      IPC.event,
      "codex:data-changed",
      { projectId: "p1" },
    );
    expect(other.webContents.send).toHaveBeenCalledExactlyOnceWith(
      IPC.event,
      "codex:data-changed",
      { projectId: "p1" },
    );
  });

  it("allowlist 外チャネルは warn して破棄する（どの窓にも届かない）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerEventBus(null);
    const w = makeWindow(1);
    allWindows.push(w);

    emitFromRenderer(w, "evil:injected", { x: 1 });

    expect(w.webContents.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("evil:injected"));
  });

  it.each([
    "chat:stream-done",
    "license:state_changed",
    "backend:ready",
    "updater:download-progress",
  ])("renderer は backend/main event %s を emit できない", (channel) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerEventBus(null);
    const w = makeWindow(1);
    allWindows.push(w);

    emitFromRenderer(w, channel, { fake: true });

    expect(w.webContents.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(channel));
  });

  it("channel が文字列でない場合も破棄する", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    registerEventBus(null);
    const w = makeWindow(1);
    allWindows.push(w);

    emitFromRenderer(w, { channel: "codex:data-changed" }, {});

    expect(w.webContents.send).not.toHaveBeenCalled();
  });

  it("backend=null でも renderer 発バスは生きる", () => {
    expect(() => registerEventBus(null)).not.toThrow();
    expect(ipcMainHandlers.has(IPC.emit)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// napi TSFn 配線（backend.onEvent → broadcast）
// ─────────────────────────────────────────────────────────────────────────────

describe("registerEventBus: napi TSFn 配線", () => {
  it("onEvent を 1 回登録し、JSON 文字列 payload を parse して全窓へ配信する", () => {
    const backend = makeBackend();
    registerEventBus(backend);
    const w1 = makeWindow(1);
    const w2 = makeWindow(2);
    allWindows.push(w1, w2);

    expect(backend.capturedCallback).not.toBeNull();
    backend.capturedCallback?.("workspace:opened", '{"path":"/tmp/ws"}');

    for (const w of [w1, w2]) {
      expect(w.webContents.send).toHaveBeenCalledExactlyOnceWith(
        IPC.event,
        "workspace:opened",
        { path: "/tmp/ws" },
      );
    }
  });

  it("workspace observer を broadcast より先に通知する", () => {
    const backend = makeBackend();
    const order: string[] = [];
    const observer = vi.fn(() => order.push("observer"));
    registerEventBus(backend, observer);
    const win = makeWindow(1);
    win.webContents.send.mockImplementation(() => {
      order.push("broadcast");
    });
    allWindows.push(win);

    backend.capturedCallback?.("workspace:opened", '{"path":"/tmp/ws"}');

    expect(observer).toHaveBeenCalledWith("workspace:opened", {
      path: "/tmp/ws",
    });
    expect(order).toEqual(["observer", "broadcast"]);
  });

  it("trusted narrative epoch wake is observer-only and never reaches BrowserWindow", () => {
    const backend = makeBackend();
    const observer = vi.fn();
    const win = makeWindow(1);
    allWindows.push(win);
    registerEventBus(backend, observer);

    backend.capturedCallback?.(
      "narrative-maintenance:epoch-rotated",
      '{"projectId":"project-1"}',
    );

    expect(observer).toHaveBeenCalledWith(
      "narrative-maintenance:epoch-rotated",
      { projectId: "project-1" },
    );
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it("napi 発でも allowlist 外チャネルは warn して破棄する（Phase 3 の更新漏れ検出）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = makeBackend();
    registerEventBus(backend);
    const w = makeWindow(1);
    allWindows.push(w);

    backend.capturedCallback?.("phase3:not-yet-listed", "{}");

    expect(w.webContents.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("phase3:not-yet-listed"),
    );
  });

  it.each(["codex:data-changed", "updater:download-progress"])(
    "napi 発では renderer/main event %s を配信しない",
    (channel) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const backend = makeBackend();
      registerEventBus(backend);
      const w = makeWindow(1);
      allWindows.push(w);

      backend.capturedCallback?.(channel, "{}");

      expect(w.webContents.send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(channel));
    },
  );

  it("JSON でない payload は warn しつつ生のまま配信する（ベストエフォート契約）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = makeBackend();
    registerEventBus(backend);
    const w = makeWindow(1);
    allWindows.push(w);

    backend.capturedCallback?.("backend:ready", "not-json");

    expect(w.webContents.send).toHaveBeenCalledExactlyOnceWith(
      IPC.event,
      "backend:ready",
      "not-json",
    );
    expect(warn).toHaveBeenCalled();
  });
});

describe("trusted event broadcast", () => {
  it("backend event は backend allowlist のみ配信する", () => {
    const w = makeWindow(1);
    allWindows.push(w);

    broadcastBackendEvent("chat:stream-done", { messageId: "m1" });
    broadcastBackendEvent("updater:download-progress", { downloaded: 1 });

    expect(w.webContents.send).toHaveBeenCalledExactlyOnceWith(
      IPC.event,
      "chat:stream-done",
      { messageId: "m1" },
    );
  });

  it("main event は main allowlist のみ配信する", () => {
    const w = makeWindow(1);
    allWindows.push(w);

    broadcastMainEvent("updater:download-progress", { downloaded: 1 });
    broadcastMainEvent("backend:ready", { fake: true });

    expect(w.webContents.send).toHaveBeenCalledExactlyOnceWith(
      IPC.event,
      "updater:download-progress",
      { downloaded: 1 },
    );
  });

  it("targeted main event は指定した main window だけへ配信する", () => {
    const main = makeWindow(21);
    const detachedPanel = makeWindow(22);
    allWindows.push(main, detachedPanel);

    sendMainEventToWindow(21, "web-editor-handoff:requested", {
      kind: "web-editor-handoff",
    });

    expect(main.webContents.send).toHaveBeenCalledExactlyOnceWith(
      IPC.event,
      "web-editor-handoff:requested",
      { kind: "web-editor-handoff" },
    );
    expect(detachedPanel.webContents.send).not.toHaveBeenCalled();
  });

  it("targeted main event は main allowlist 外を配信しない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const main = makeWindow(21);
    allWindows.push(main);

    sendMainEventToWindow(21, "backend:ready", { fake: true });

    expect(main.webContents.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("backend:ready"));
  });

  it("authority-bearing backend event は指定した窓だけへ配信する", () => {
    const owner = makeWindow(11);
    const other = makeWindow(12);
    allWindows.push(owner, other);

    sendBackendEventToWindow(11, "codex-app:event", { requestId: 7 });

    expect(owner.webContents.send).toHaveBeenCalledExactlyOnceWith(
      IPC.event,
      "codex-app:event",
      { requestId: 7 },
    );
    expect(other.webContents.send).not.toHaveBeenCalled();
  });

  it("対象窓が破棄済みなら authority-bearing event を配信しない", () => {
    const owner = makeWindow(11);
    owner.destroyed = true;
    allWindows.push(owner);

    sendBackendEventToWindow(11, "codex-app:event", { requestId: 7 });

    expect(owner.webContents.send).not.toHaveBeenCalled();
  });

  it("targeted send と renderer destruction の競合を main へ伝播させない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const owner = makeWindow(11);
    owner.webContents.send.mockImplementation(() => {
      throw new Error("renderer gone");
    });
    allWindows.push(owner);

    expect(() =>
      sendBackendEventToWindow(11, "codex-app:event", { requestId: 7 }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("renderer gone"));
  });
});

describe("NIR-1 invalidation event", () => {
  it("accepts only the Native opaque query binding and refuses renderer spoofing", () => {
    const window = makeWindow(41);
    allWindows.push(window);
    const backend = makeBackend();
    registerEventBus(backend);
    backend.capturedCallback?.("related-scenes:invalidated", '{"queryBinding":"query-binding"}');
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC.event, "related-scenes:invalidated", { queryBinding: "query-binding" });
    window.webContents.send.mockClear();
    emitFromRenderer(window, "related-scenes:invalidated", { queryBinding: "query-binding" });
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it("does not forward malformed payloads or extra Native data", () => {
    const window = makeWindow(42);
    allWindows.push(window);
    const backend = makeBackend();
    registerEventBus(backend);
    for (const payload of ['not-json', '{}', '{"queryBinding":" "}', '{"queryBinding":"ok","envelope":"must-not-leak"}']) {
      backend.capturedCallback?.("related-scenes:invalidated", payload);
    }
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
});

describe("NIR-1 newly usable index notification", () => {
  it("accepts a Native project-only readiness event and refuses extra disclosure", () => {
    const window = makeWindow(43);
    allWindows.push(window);
    const backend = makeBackend();
    registerEventBus(backend);
    backend.capturedCallback?.("related-scenes:index-ready", '{"projectId":"project"}');
    expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC.event, "related-scenes:index-ready", { projectId: "project" });
    window.webContents.send.mockClear();
    backend.capturedCallback?.("related-scenes:index-ready", '{"projectId":"project","count":9}');
    emitFromRenderer(window, "related-scenes:index-ready", { projectId: "project" });
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
});
