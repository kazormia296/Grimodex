/**
 * preload（sandbox:true / contextIsolation:true）— GrimodexBridge のフル API
 * （設計書 §5.4、Phase 2 S4。renderer 参照用の型は src/types/grimodex-bridge.d.ts）。
 *
 * - `invoke` は Envelope を**そのまま**返す。生文字列 reject への解封は
 *   src/lib/tauri.ts の electron 分岐（S5）が行う — Tauri のエラー文字列契約
 *   （§5.2）の保存のため、この層では触らない。
 * - ブリッジ native API（dialog / fs / …）は preload で Envelope を解封し、
 *   `Error(message)` の reject に変換する。
 * - イベントは `"grim:event"` 1 本に集約し、チャネル多重化は preload の
 *   Map で行う（§7.2）。listen / emit とも allowlist 外は拒否する。
 * - close veto（§6.4 手順 2）: `grim:close-requested` を受けたら登録済み
 *   ハンドラ（同期）を実行し `grim:close-reply` に { veto } を返す。
 *   ハンドラ登録数は `grim:close-handler-changed` で main へ通知し、
 *   未登録の窓は問い合わせなしで即 close される（手順 4。main 側は windows.ts）。
 */
import { contextBridge, ipcRenderer } from "electron";

import {
  IPC,
  isAllowedEventChannel,
  isAllowedRendererEventChannel,
} from "../shared/ipcContract.js";
import type { Envelope } from "../shared/ipcContract.js";

function unwrap<T>(envelope: Envelope<T>): T {
  if (envelope.ok) return envelope.value;
  throw new Error(envelope.error);
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return unwrap((await ipcRenderer.invoke(channel, ...args)) as Envelope<T>);
}

// ── イベント多重化（grim:event 1 本 → チャネル別リスナ） ──────────────────────

type EventCallback = (payload: unknown) => void;
const eventListeners = new Map<string, Set<EventCallback>>();

/**
 * §7.2: unlisten 呼び忘れ検出（dev のみ = ELECTRON_RENDERER_URL がある起動。
 * sandbox preload の process ポリフィルは env を持つ）。同一チャネルの
 * リスナ数が閾値を超えたら 1 回だけ warn し、閾値を下回れば再武装する。
 */
const LISTENER_LEAK_THRESHOLD = 32;
const leakWarnedChannels = new Set<string>();

function checkListenerLeak(channel: string, size: number): void {
  if (!process.env.ELECTRON_RENDERER_URL) return;
  if (size < LISTENER_LEAK_THRESHOLD) {
    leakWarnedChannels.delete(channel);
    return;
  }
  if (leakWarnedChannels.has(channel)) return;
  leakWarnedChannels.add(channel);
  console.warn(
    `[grimodex] possible event listener leak: "${channel}" has ${size} ` +
      "listeners (unlisten の呼び忘れを確認してください)",
  );
}

ipcRenderer.on(IPC.event, (_event, channel: unknown, payload: unknown) => {
  if (typeof channel !== "string") return;
  const set = eventListeners.get(channel);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb(payload);
    } catch (e) {
      console.error(`[grimodex] event listener failed (${channel}):`, e);
    }
  }
});

// ── close veto プロトコル（§6.4 手順 2） ─────────────────────────────────────

type CloseRequestedHandler = () => boolean;
const closeHandlers = new Set<CloseRequestedHandler>();

/**
 * §6.4 手順 4 のための登録数通知。main はハンドラ未登録の窓
 * （起動直後など）を問い合わせなしで即 close する。
 */
function notifyCloseHandlerCount(): void {
  ipcRenderer.send(IPC.closeHandlerChanged, closeHandlers.size);
}

ipcRenderer.on(IPC.closeRequested, () => {
  let veto = false;
  for (const cb of [...closeHandlers]) {
    try {
      veto = cb() || veto;
    } catch (e) {
      // ハンドラ例外で窓が閉じられなくなる事故を避ける（veto しない側に倒す）
      console.error("[grimodex] close-requested handler failed:", e);
    }
  }
  ipcRenderer.send(IPC.closeReply, { veto });
});

// ── resize / maximize 通知（main 側の win.on 配線は S6） ─────────────────────

const resizeHandlers = new Set<() => void>();

ipcRenderer.on(IPC.windowResized, () => {
  for (const cb of [...resizeHandlers]) {
    try {
      cb();
    } catch (e) {
      console.error("[grimodex] resize handler failed:", e);
    }
  }
});

// ── GrimodexBridge（§5.4 契約） ──────────────────────────────────────────────

function assertAllowedListenChannel(channel: string): void {
  if (!isAllowedEventChannel(channel)) {
    throw new Error(`EVENT_CHANNEL_NOT_ALLOWED: ${channel}`);
  }
}

function assertAllowedRendererEventChannel(channel: string): void {
  if (!isAllowedRendererEventChannel(channel)) {
    throw new Error(`EVENT_CHANNEL_NOT_ALLOWED: ${channel}`);
  }
}

const bridge = {
  shell: "electron" as const,

  invoke(cmd: string, args?: Record<string, unknown>): Promise<Envelope> {
    return ipcRenderer.invoke(IPC.invoke, cmd, args) as Promise<Envelope>;
  },

  /** 同期 unlisten 返し（wrapper 側で Promise 化 — §5.4）。 */
  listen(channel: string, cb: (payload: unknown) => void): () => void {
    assertAllowedListenChannel(channel);
    let set = eventListeners.get(channel);
    if (!set) {
      set = new Set();
      eventListeners.set(channel, set);
    }
    set.add(cb);
    checkListenerLeak(channel, set.size);
    return () => {
      const current = eventListeners.get(channel);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) eventListeners.delete(channel);
    };
  },

  /** 全窓配信 + 自己配信（Tauri v2 emit 契約）。main が allowlist を再検証する。 */
  emit(channel: string, payload?: unknown): Promise<void> {
    assertAllowedRendererEventChannel(channel);
    ipcRenderer.send(IPC.emit, channel, payload);
    return Promise.resolve();
  },

  windowControls: {
    minimize: (): Promise<void> => call(IPC.windowControl, "minimize"),
    toggleMaximize: (): Promise<void> =>
      call(IPC.windowControl, "toggleMaximize"),
    close: (): Promise<void> => call(IPC.windowControl, "close"),
    isMaximized: (): Promise<boolean> => call(IPC.windowControl, "isMaximized"),
    onResized(cb: () => void): () => void {
      resizeHandlers.add(cb);
      return () => {
        resizeHandlers.delete(cb);
      };
    },
    /** cb が true を返したら veto（閉じない）。 */
    onCloseRequested(cb: () => boolean): () => void {
      closeHandlers.add(cb);
      notifyCloseHandlerCount();
      return () => {
        if (closeHandlers.delete(cb)) notifyCloseHandlerCount();
      };
    },
  },

  dialog: {
    openFolder: (): Promise<string | null> => call(IPC.dialogOpenFolder),
    openFile: (filter: {
      name: string;
      extensions: string[];
    }): Promise<string | null> => call(IPC.dialogOpenFile, filter),
    openWebEditorHandoff: (): Promise<{
      name: string;
      content: string;
    } | null> => call(IPC.dialogOpenWebEditorHandoff),
  },

  fs: {
    readTextFile: (path: string): Promise<string> =>
      call(IPC.fsReadTextFile, path),
    readDir: (
      path: string,
    ): Promise<
      {
        name: string;
        isDirectory: boolean;
        isFile: boolean;
        isSymlink: boolean;
      }[]
    > => call(IPC.fsReadDir, path),
  },

  openExternal: (url: string): Promise<void> => call(IPC.openExternal, url),

  getVersion: (): Promise<string> => call(IPC.getVersion),

  setZoomFactor: (factor: number): Promise<void> =>
    call(IPC.setZoomFactor, factor),

  panelWindow: {
    // 実体は main の windows.ts（§6.5 — label 検証 + URL は main が組み立て）。
    open: (
      label: string,
      opts: { width: number; height: number; title: string },
    ): Promise<void> => call(IPC.panelOpen, label, opts),
    focusByLabel: (label: string): Promise<boolean> =>
      call(IPC.panelFocus, label),
  },
};

contextBridge.exposeInMainWorld("grimodex", bridge);
