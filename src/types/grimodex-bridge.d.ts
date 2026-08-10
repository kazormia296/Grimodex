/**
 * Electron preload（electron/preload/index.ts）が `window.grimodex` に公開する
 * GrimodexBridge の renderer 参照用型（設計書 §5.4。契約の実体は
 * electron/shared/ipcContract.ts — 両者は手動で同期する）。
 *
 * `invoke` は envelope をそのまま返す。typed `IpcInvokeError`（legacy message
 * 互換）への解封は src/lib/tauri.ts の electron 分岐が行う。
 */

export type GrimodexIpcErrorCode =
  | "WORKSPACE_SWITCHING"
  | "NO_WORKSPACE_OPEN"
  | "RERANKER_BUSY"
  | "IPC_UNIMPLEMENTED"
  | "IPC_BACKEND_UNAVAILABLE"
  | "IPC_SECRETS_UNAVAILABLE"
  | "UNKNOWN";

export interface GrimodexIpcErrorInfo {
  code: GrimodexIpcErrorCode;
  message: string;
  retryable: boolean;
  outcome: "failed" | "unknown";
  details?: Record<string, unknown>;
}

export type GrimodexInvokeEnvelope<T = unknown> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: string;
      /** Typed wire for new callers; `error` remains for compatibility. */
      errorInfo?: GrimodexIpcErrorInfo;
      /**
       * Tauri がエラーを object で serialize するコマンド（lint_text の
       * LintError = {type, data}）の reject 値。解封側は
       * `errorValue` は raw object のまま throw する。
       */
      errorValue?: unknown;
    };

/** @tauri-apps/plugin-fs の DirEntry / src/lib/fs.ts の DirEntry と同形。 */
export interface GrimodexDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export interface GrimodexOpenTextResult {
  name: string;
  content: string;
}

export interface GrimodexBridge {
  readonly shell: "electron";
  /**
   * Electron runtime performance harness が preload 前に発行したときだけ存在する。
   * 通常の production renderer には mutation control を一切公開しない。
   */
  readonly runtimePerformance?: {
    readonly ownerToken: string;
  };
  invoke<T = unknown>(
    cmd: string,
    args?: Record<string, unknown>,
  ): Promise<GrimodexInvokeEnvelope<T>>;
  /** 同期 unlisten 返し。wrapper 側で Promise 化する。allowlist 外は throw。 */
  listen(channel: string, cb: (payload: unknown) => void): () => void;
  /** 全窓配信 + 自己配信（Tauri v2 emit 契約）。allowlist 外は reject。 */
  emit(channel: string, payload?: unknown): Promise<void>;
  windowControls: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    toggleFullscreen(): Promise<boolean>;
    isFullscreen(): Promise<boolean>;
    onResized(cb: () => void): () => void;
    /** cb が true を返したら veto（閉じない）。 */
    onCloseRequested(cb: () => boolean): () => void;
  };
  dialog: {
    openFolder(): Promise<string | null>;
    openFile(filter: {
      name: string;
      extensions: string[];
    }): Promise<string | null>;
    /** main側の固定上限内で選択・読込を完結するhandoff専用ピッカ。 */
    openWebEditorHandoff(): Promise<GrimodexOpenTextResult | null>;
  };
  fs: {
    readTextFile(path: string): Promise<string>;
    readDir(path: string): Promise<GrimodexDirEntry[]>;
  };
  openExternal(url: string): Promise<void>;
  getVersion(): Promise<string>;
  setZoomFactor(factor: number): Promise<void>;
  panelWindow: {
    open(
      label: string,
      opts: { width: number; height: number; title: string },
    ): Promise<void>;
    focusByLabel(label: string): Promise<boolean>;
    /** Compatibility fallback is kept renderer-side for older preload mocks. */
    existsByLabel?(label: string): Promise<boolean>;
  };
}

declare global {
  interface Window {
    /** Electron シェルでのみ preload が注入する（isElectron() 判定の実体）。 */
    grimodex?: GrimodexBridge;
  }
}
