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

const { broadcastEvent, registerEventBus } = await import("./events.js");

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
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("evil:injected"),
    );
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
