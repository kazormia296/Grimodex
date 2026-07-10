/**
 * label 別 window-state 永続化（設計書 §6.7、Phase 2 S4 でモジュール新設。
 * windows.ts への接続 — 生成時復元 / resize・move 購読 — は S6）。
 *
 * - `userData/window-state.json` に `label → { bounds, maximized }`
 * - 保存は 500ms debounce（tauri-plugin-window-state と同じ main 内完結）
 * - 復元時はディスプレイ交差判定で画面外復元を防ぐ（純関数 — 単体テスト対象）
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowStateEntry {
  bounds: WindowBounds;
  maximized: boolean;
}

export type WindowStates = Record<string, WindowStateEntry>;

const SAVE_DEBOUNCE_MS = 500;

/** 「見えている」と判定する最小の交差サイズ（タイトルバーを掴める程度）。 */
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 40;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isValidBounds(v: unknown): v is WindowBounds {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    isFiniteNumber(b.x) &&
    isFiniteNumber(b.y) &&
    isFiniteNumber(b.width) &&
    isFiniteNumber(b.height) &&
    (b.width as number) > 0 &&
    (b.height as number) > 0
  );
}

/** JSON ファイル由来の値を検証して WindowStates に正規化する（不正は捨てる）。 */
export function sanitizeWindowStates(raw: unknown): WindowStates {
  if (typeof raw !== "object" || raw === null) return {};
  const out: WindowStates = {};
  for (const [label, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (!isValidBounds(e.bounds)) continue;
    out[label] = { bounds: e.bounds, maximized: e.maximized === true };
  }
  return out;
}

/**
 * 保存済み bounds がいずれかのディスプレイ内に十分見えていればそのまま返し、
 * 画面外なら null（呼び出し側はデフォルト位置に落とす）。
 * `displays` には `screen.getAllDisplays().map((d) => d.workArea)` を渡す。
 */
export function clampBoundsToDisplays(
  bounds: WindowBounds,
  displays: readonly WindowBounds[],
): WindowBounds | null {
  for (const d of displays) {
    const visibleW =
      Math.min(bounds.x + bounds.width, d.x + d.width) - Math.max(bounds.x, d.x);
    const visibleH =
      Math.min(bounds.y + bounds.height, d.y + d.height) -
      Math.max(bounds.y, d.y);
    if (visibleW >= MIN_VISIBLE_WIDTH && visibleH >= MIN_VISIBLE_HEIGHT) {
      return bounds;
    }
  }
  return null;
}

export interface WindowStateStore {
  get(label: string): WindowStateEntry | undefined;
  /** 500ms debounce で書き出す。 */
  set(label: string, entry: WindowStateEntry): void;
  /** quit 前に呼ぶ（pending があれば同期書き出し）。 */
  flush(): void;
}

/** `userData/window-state.json` を正本にした store を作る。 */
export function createWindowStateStore(userDataDir: string): WindowStateStore {
  const filePath = path.join(userDataDir, "window-state.json");
  let states: WindowStates;
  try {
    states = sanitizeWindowStates(
      JSON.parse(readFileSync(filePath, "utf8")) as unknown,
    );
  } catch {
    states = {}; // 初回起動 / 破損ファイルは空から
  }

  let timer: NodeJS.Timeout | null = null;
  let dirty = false;

  const writeNow = () => {
    dirty = false;
    try {
      mkdirSync(userDataDir, { recursive: true });
      writeFileSync(filePath, `${JSON.stringify(states, null, 2)}\n`, "utf8");
    } catch (e) {
      console.warn(`[window-state] save failed: ${String(e)}`);
    }
  };

  return {
    get: (label) => states[label],
    set: (label, entry) => {
      states[label] = entry;
      dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(writeNow, SAVE_DEBOUNCE_MS);
      timer.unref?.();
    },
    flush: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (dirty) writeNow();
    },
  };
}
