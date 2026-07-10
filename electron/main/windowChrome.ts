/**
 * ウィンドウクロームの純関数部（設計書 §6.1 / §6.4 / §6.5、Phase 2 S6/S7）。
 *
 * electron を実行時 import しない（型のみ）純粋モジュール。
 * windows.ts が BrowserWindow / Menu / ipcMain へ配線するグルーを担い、
 * ここは vitest node 環境（vitest.electron.config.ts）で単体テストする:
 * - buildMainWindowOptions: §6.1 パリティ表 + window-state 復元優先
 * - applicationMenuPolicy: §6.1 メニュー方針（zoom ロールなし）
 * - createCloseVetoController: §6.4 close veto 非同期プロトコル
 *   （1,500ms タイマ満了パス含む）
 * - isValidPanelLabel / buildPanelUrl / buildPanelWindowOptions:
 *   §6.5 パネル別窓（label 検証 + URL は main が組み立てる）
 */
import type { BrowserWindowConstructorOptions } from "electron";

import { clampBoundsToDisplays } from "./windowState.js";
import type { WindowBounds, WindowStateEntry } from "./windowState.js";

// ─────────────────────────────────────────────────────────────────────────────
// §6.1 メイン窓の生成パリティ（tauri.conf.json → BrowserWindow）
// ─────────────────────────────────────────────────────────────────────────────

/** tauri.conf.json の width/height/min* と同値（§6.1）。 */
export const MAIN_WINDOW_DEFAULTS = {
  width: 800,
  height: 600,
  minWidth: 600,
  minHeight: 400,
} as const;

/**
 * macOS titleBarStyle:"hidden" 時のネイティブ信号機位置。
 * ヘッダバー（TitleBar / HeaderBarLayout）の左端と重ならない控えめな位置。
 * 実機確認は §11 の未決事項（NG なら frame:false へ後退 — §6.1）。
 */
export const TRAFFIC_LIGHT_POSITION = { x: 12, y: 12 } as const;

export interface MainWindowChrome {
  /** BrowserWindow コンストラクタへ渡す共通オプション（webPreferences 除く）。 */
  options: BrowserWindowConstructorOptions;
  /**
   * 復元 state が maximized だった場合 true。maximize() は非表示窓を
   * 表示させる副作用があるため、呼び出し側は show() の直前に maximize する。
   */
  startMaximized: boolean;
}

/**
 * §6.1 パリティ表 + §6.7 window-state 復元を写したオプション組み立て。
 * - win/linux: `frame:false`（decorations:false 相当）
 * - macOS: `titleBarStyle:"hidden"` + trafficLightPosition
 *   （現行 Tauri mac は操作系が空白のため、ネイティブ信号機を残す方が改善）
 * - 保存済み bounds はディスプレイ交差判定を通った場合のみ復元
 *   （画面外はデフォルト位置へ。デフォルトサイズより優先 — §6.1）
 */
export function buildMainWindowOptions(input: {
  platform: NodeJS.Platform;
  savedState: WindowStateEntry | undefined;
  displayWorkAreas: readonly WindowBounds[];
}): MainWindowChrome {
  const { platform, savedState, displayWorkAreas } = input;

  const frameOptions: BrowserWindowConstructorOptions =
    platform === "darwin"
      ? {
          titleBarStyle: "hidden",
          trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION },
        }
      : { frame: false };

  const options: BrowserWindowConstructorOptions = {
    ...MAIN_WINDOW_DEFAULTS,
    ...frameOptions,
    transparent: true,
    backgroundColor: "#00000000",
    show: false,
  };

  const restored = savedState
    ? clampBoundsToDisplays(savedState.bounds, displayWorkAreas)
    : null;
  if (restored) {
    options.x = restored.x;
    options.y = restored.y;
    options.width = Math.max(restored.width, MAIN_WINDOW_DEFAULTS.minWidth);
    options.height = Math.max(restored.height, MAIN_WINDOW_DEFAULTS.minHeight);
  }

  return {
    options,
    // bounds が画面外でも maximized は現在のディスプレイで復元して安全
    startMaximized: savedState?.maximized === true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §6.5 パネル別窓（WebviewWindow → BrowserWindow）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * パネル窓 label の検証パターン（§6.5）。Tauri capability の
 * windows scope glob `panel-*` の代替となる侵害時ガード —
 * renderer が任意 label で窓を作れないよう列挙的な文字クラスに絞る。
 */
export const PANEL_LABEL_PATTERN = /^panel-[a-z0-9-]+$/;

export const PANEL_WINDOW_LABEL_PREFIX = "panel-";

export function isValidPanelLabel(label: unknown): label is string {
  return typeof label === "string" && PANEL_LABEL_PATTERN.test(label);
}

/**
 * パネル窓 URL は main が label から組み立てる（renderer 供給 URL 拒否 — §6.5）。
 * - dev: `${ELECTRON_RENDERER_URL}/?window=panel&panel=<id>`
 * - prod: `app://bundle/index.html?window=panel&panel=<id>`（app:// は S8）
 * `<id>` は label から `panel-` プレフィックスを剥がしたもの
 * （renderer 側 parsePanelWindowTarget の受理形式）。
 */
export function buildPanelUrl(
  rendererUrl: string | undefined,
  label: string,
): string {
  const id = label.slice(PANEL_WINDOW_LABEL_PREFIX.length);
  const query = `window=panel&panel=${encodeURIComponent(id)}`;
  if (rendererUrl) {
    return `${rendererUrl.replace(/\/+$/, "")}/?${query}`;
  }
  return `app://bundle/index.html?${query}`;
}

/** feature 層 buildPanelWindowOptions（480×900）と同値のデフォルト。 */
export const PANEL_WINDOW_DEFAULTS = { width: 480, height: 900 } as const;

/** renderer 入力を信用しない寸法サニタイズ（非数・非正は default に落とす）。 */
function sanePanelSize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.round(value);
}

/**
 * §6.5: transparent / frame:false（全 OS — Tauri パネル窓の decorations:false
 * と同挙動）/ requested サイズ / label 別 window-state 復元（requested より優先）。
 * 親子関係は付けない（現行はフローティング独立窓）。
 */
export function buildPanelWindowOptions(input: {
  savedState: WindowStateEntry | undefined;
  displayWorkAreas: readonly WindowBounds[];
  requested: { width?: unknown; height?: unknown; title?: unknown };
}): MainWindowChrome {
  const { savedState, displayWorkAreas, requested } = input;

  const options: BrowserWindowConstructorOptions = {
    width: sanePanelSize(requested.width, PANEL_WINDOW_DEFAULTS.width),
    height: sanePanelSize(requested.height, PANEL_WINDOW_DEFAULTS.height),
    title: typeof requested.title === "string" ? requested.title : "Grimodex",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    show: false,
  };

  const restored = savedState
    ? clampBoundsToDisplays(savedState.bounds, displayWorkAreas)
    : null;
  if (restored) {
    options.x = restored.x;
    options.y = restored.y;
    options.width = restored.width;
    options.height = restored.height;
  }

  return { options, startMaximized: savedState?.maximized === true };
}

// ─────────────────────────────────────────────────────────────────────────────
// §6.1 メニュー方針
// ─────────────────────────────────────────────────────────────────────────────

export type ApplicationMenuPolicy =
  | { kind: "null" } // win/linux: Menu.setApplicationMenu(null)
  | { kind: "roles"; roles: readonly ("appMenu" | "editMenu" | "windowMenu")[] };

/**
 * zoomHotkeysEnabled:false のパリティ: どの分岐でも zoom ロール
 * （viewMenu / zoomIn / zoomOut）を載せない。
 * macOS は Cmd+C/V が死ぬため editMenu/windowMenu の最小メニューが必須で、
 * 先頭スロットは常にアプリメニューに割り当てられるため appMenu ロールを
 * 明示する（Cmd+Q / Cmd+H の維持）。
 */
export function applicationMenuPolicy(
  platform: NodeJS.Platform,
): ApplicationMenuPolicy {
  if (platform === "darwin") {
    return { kind: "roles", roles: ["appMenu", "editMenu", "windowMenu"] };
  }
  return { kind: "null" };
}

// ─────────────────────────────────────────────────────────────────────────────
// §6.4 close veto（onCloseRequested 契約の非同期問い合わせプロトコル）
// ─────────────────────────────────────────────────────────────────────────────

/** renderer ハング時の閉じ損ね防止タイマ（§6.4 手順 1/3）。 */
export const CLOSE_VETO_TIMEOUT_MS = 1500;

export interface CloseVetoHooks {
  /** §6.4 手順 1: `grim:close-requested` を renderer へ送る。 */
  requestClose(): void;
  /** §6.4 手順 3: veto=false またはタイマ満了で `win.close()` を再発行する。 */
  forceClose(): void;
  /** テスト用の上書き（既定 CLOSE_VETO_TIMEOUT_MS）。 */
  timeoutMs?: number;
}

export interface CloseVetoController {
  /**
   * `win.on("close")` から呼ぶ。false を返したら `e.preventDefault()` する。
   * - forceClose 済み → true（手順 3 の再発行を素通し）
   * - renderer 側ハンドラ未登録 → true（手順 4: 起動直後などは即 close）
   * - 問い合わせ中の二重 close 要求 → false（再発行しない）
   */
  onCloseEvent(): boolean;
  /** `grim:close-reply`（手順 2 の応答）。タイマ満了後の遅延 reply は無視。 */
  onReply(veto: boolean): void;
  /** preload からのハンドラ登録数通知（`grim:close-handler-changed`）。 */
  setHandlerRegistered(registered: boolean): void;
  /** `closed` 後に呼ぶ（進行中タイマの破棄）。 */
  dispose(): void;
}

export function createCloseVetoController(
  hooks: CloseVetoHooks,
): CloseVetoController {
  const timeoutMs = hooks.timeoutMs ?? CLOSE_VETO_TIMEOUT_MS;
  let forceClose = false;
  let handlerRegistered = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const clearPending = (): void => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  const settleAndClose = (): void => {
    clearPending();
    forceClose = true;
    hooks.forceClose();
  };

  return {
    onCloseEvent() {
      if (forceClose) return true;
      if (!handlerRegistered) return true;
      if (pendingTimer) return false;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        settleAndClose();
      }, timeoutMs);
      hooks.requestClose();
      return false;
    },
    onReply(veto) {
      if (!pendingTimer) return;
      if (veto) {
        clearPending(); // 閉じない。次の close 要求で改めて問い合わせる
        return;
      }
      settleAndClose();
    },
    setHandlerRegistered(registered) {
      handlerRegistered = registered;
    },
    dispose: clearPending,
  };
}
