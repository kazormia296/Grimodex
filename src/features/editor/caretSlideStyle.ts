/**
 * スムースキャレットのスライド transition（duration / easing）を設定値から
 * 導出する純関数群。実体は CSS 変数で、.typewriter-cursor（エディタ本体）と
 * .caret-preview-caret（設定のプレビュー）の両方が参照する。
 */

export const CARET_SLIDE_DURATION_DEFAULT = 80;
export const CARET_SLIDE_SNAPPINESS_DEFAULT = 50;
/** 設定スライダーと同じ範囲。範囲外の永続値 (インポート等) もここへクランプ
 * する — 負値などが transition に入ると宣言全体が silent に無効化されるため。 */
export const CARET_SLIDE_DURATION_MIN = 40;
export const CARET_SLIDE_DURATION_MAX = 200;

/**
 * snappiness (0–100) → cubic-bezier(x1, y1, 0.36, 1) の一族。
 * 50 が従来カーブ (0.22, 1, 0.36, 1)。0 側は穏やかな ease-out (0.33, 0.66)、
 * 100 側はオーバーシュート付き (0.11, 1.34) — かつて 1.21 で存在した
 * バネ挙動 (f6de4e0e 以前) を上限側で選べるようにした系譜。
 */
export function caretSlideEasing(snappiness: number): string {
  const s = Math.min(100, Math.max(0, snappiness));
  const x1 = round3(0.33 - 0.0022 * s);
  const y1 = round3(0.66 + 0.0068 * s);
  return `cubic-bezier(${x1}, ${y1}, 0.36, 1)`;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * slide duration を設定スライダーと同じ範囲へクランプする。CSS 変数書き込み
 * (applyCaretSlideVars) と、高速入力検出の閾値 (CursorOverlayPlugin) の両方が
 * 同じ実効 duration を使うよう共有する。
 */
export function clampCaretSlideDuration(durationMs: number): number {
  return Math.min(
    CARET_SLIDE_DURATION_MAX,
    Math.max(CARET_SLIDE_DURATION_MIN, durationMs),
  );
}

/**
 * 設定値を CSS 変数へ反映する。呼び出しは冪等（エディタが複数あっても同値）。
 */
export function applyCaretSlideVars(
  durationMs: number,
  snappiness: number,
  root: HTMLElement = document.documentElement,
): void {
  const d = clampCaretSlideDuration(durationMs);
  root.style.setProperty("--caret-slide-duration", `${Math.round(d)}ms`);
  root.style.setProperty("--caret-slide-easing", caretSlideEasing(snappiness));
}
