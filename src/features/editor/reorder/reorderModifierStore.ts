import { create } from "zustand";
import { isWebKitGtk } from "@/lib/platform";
import type { ReorderGranularity } from "./types";

/**
 * 推敲リオーダーの修飾キー UI モード。
 *   none     … 平常
 *   alt      … Alt 押下中 = 段落(最上位ブロック)並べ替え
 *   altShift … Alt+Shift 押下中 = 段落内 文/文節 並べ替え
 */
export type ReorderModifierMode = "none" | "alt" | "altShift";

/**
 * 修飾キー状態 → UI モード。純粋関数（テスト対象）。
 * Alt/Alt+Shift 単独のときだけ発火する。Ctrl や Meta を伴う場合は none:
 *   - Windows AltGr は Ctrl+RightAlt（altKey かつ ctrlKey）で「€」等を入力する
 *   - macOS の Option 組版（Option+Shift+ハイフンで em ダッシュ等）は Cmd を
 *     伴わないが、Cmd+Option ショートカットは reorder ではないので除外する
 * これらを reorder モードと誤認するとタイプ中に色帯/ハンドルがちらつき、
 * mousedown がドラッグへ乗っ取られる。
 */
export function computeModifierMode(
  alt: boolean,
  shift: boolean,
  ctrl = false,
  meta = false,
): ReorderModifierMode {
  if (ctrl || meta) return "none";
  if (alt && shift) return "altShift";
  if (alt) return "alt";
  return "none";
}

interface ReorderModifierState {
  mode: ReorderModifierMode;
  /**
   * フォーカス中エディタの並べ替え粒度のミラー（フッター表示用）。
   * 正本は各エディタの reorderKey plugin state。トグル/セット時にここへ写す。
   */
  granularity: ReorderGranularity;
  setMode: (mode: ReorderModifierMode) => void;
  setGranularity: (granularity: ReorderGranularity) => void;
}

export const useReorderModifierStore = create<ReorderModifierState>()(
  (set, get) => ({
    mode: "none",
    granularity: "sentence",
    // 同値なら set しない（無駄な listener 通知＝プラグイン再 dispatch を避ける）。
    setMode: (mode) => {
      if (get().mode !== mode) set({ mode });
    },
    setGranularity: (granularity) => {
      if (get().granularity !== granularity) set({ granularity });
    },
  }),
);

// ── window 修飾キーリスナ（refcount 共有）─────────────────────────────
// Linear モードの複数エディタが同時にプラグインを持っても、window リスナは
// 1 組だけにする。各プラグイン view() と フッター hook が acquire/release する。

let refCount = 0;
let attached = false;

function syncFromEvent(e: Event): void {
  const ke = e as KeyboardEvent;
  let alt = "altKey" in ke ? Boolean(ke.altKey) : false;
  let shift = "shiftKey" in ke ? Boolean(ke.shiftKey) : false;
  let ctrl = "ctrlKey" in ke ? Boolean(ke.ctrlKey) : false;
  let meta = "metaKey" in ke ? Boolean(ke.metaKey) : false;
  // WebKitGTK (GDK) は keyup の modifier state に「離す直前」の状態を入れる
  // ため、離したキー自身のフラグが立ったまま届く (WebKit の WebEventFactory は
  // KEY_RELEASE でこの補正をしない)。key/code で自前クリアしないと Alt を
  // 離してもハンドルが消えない。Blink/WKWebView は keyup の state が正しい
  // ので補正しない — 全エンジンに掛けると「左右 Alt 同時押しで片方だけ離す」
  // とき正しい altKey=true まで潰してしまう。
  if (ke.type === "keyup" && isWebKitGtk()) {
    if (
      ke.key === "Alt" ||
      ke.key === "AltGraph" ||
      ke.code === "AltLeft" ||
      ke.code === "AltRight"
    ) {
      alt = false;
    }
    if (ke.key === "Shift") shift = false;
    if (ke.key === "Control") ctrl = false;
    if (ke.key === "Meta") meta = false;
  }
  useReorderModifierStore
    .getState()
    .setMode(computeModifierMode(alt, shift, ctrl, meta));
}

function resetMode(): void {
  useReorderModifierStore.getState().setMode("none");
}

/**
 * window の Alt/Shift 押下状態の追跡を開始する。返り値で解放（refcount）。
 * capture フェーズで観測し、preventDefault は一切しない（Alt+矢印などの
 * TipTap ショートカットを壊さないため）。alt-tab 等で keyup を取り逃した
 * ケースは blur / visibilitychange で none に戻す。
 */
export function acquireModifierListeners(): () => void {
  refCount += 1;
  if (!attached) {
    attached = true;
    window.addEventListener("keydown", syncFromEvent, true);
    window.addEventListener("keyup", syncFromEvent, true);
    window.addEventListener("blur", resetMode);
    document.addEventListener("visibilitychange", resetMode);
  }
  return () => {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0 && attached) {
      attached = false;
      window.removeEventListener("keydown", syncFromEvent, true);
      window.removeEventListener("keyup", syncFromEvent, true);
      window.removeEventListener("blur", resetMode);
      document.removeEventListener("visibilitychange", resetMode);
      resetMode();
    }
  };
}
