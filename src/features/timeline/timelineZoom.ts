export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4.0;
export const ZOOM_STEP = 1.25;
export const STEP_BASE = 96;

/**
 * 全シーンがコンテナ幅に収まるズーム倍率を計算する。
 * @param sceneCount  表示シーン数
 * @param containerWidth  コンテナの実際の px 幅
 * @param baseStep  zoom=1 のときの1シーンあたり幅 (px)
 * @param padding  左右パディング合計 (px)
 */
export function computeFitZoom(
  sceneCount: number,
  containerWidth: number,
  baseStep: number,
  padding: number,
): number {
  if (sceneCount <= 0 || containerWidth <= 0) return ZOOM_MIN;
  const usable = Math.max(0, containerWidth - padding);
  const raw = usable / (sceneCount * baseStep);
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, raw));
}

/**
 * ホイールズーム後に「カーソル下のコンテンツ点を画面上の同じ位置に保つ」ための
 * 新しい scrollLeft を計算する（zoom-to-cursor）。
 *
 * コンテンツの x レイアウトは `padLeft + (ズームに比例して伸縮する部分)` の形をしており、
 * 左の固定ガター/パディング（padLeft）はズームで伸縮しない。したがって、ある content x の
 * うちスケールするのは `(x - padLeft)` の部分だけで、`(x - padLeft)` は zoom に正比例する。
 *
 * カーソル下の content 座標 = `scrollLeft + cursorX`。ズーム後もそれが同じ画面 px
 * （cursorX）に来るよう scrollLeft を解くと下式になる。
 *
 * @param scrollLeft  ズーム前の scrollLeft（px）
 * @param cursorX     スクロールコンテナ左端からのカーソル X（px）= clientX - rect.left
 * @param padLeft     ズームで伸縮しない左固定オフセット（px）
 * @param prevZoom    ズーム前の倍率
 * @param nextZoom    クランプ後の新しい倍率
 * @returns カーソル下の点を固定する新しい scrollLeft（実際の適用時にブラウザがクランプ）
 */
export function computeZoomScrollLeft(
  scrollLeft: number,
  cursorX: number,
  padLeft: number,
  prevZoom: number,
  nextZoom: number,
): number {
  if (prevZoom <= 0) return scrollLeft;
  const ratio = nextZoom / prevZoom;
  // カーソル下の content 座標のうち、ズームでスケールする部分（padLeft 超過分）。
  const scaled = scrollLeft + cursorX - padLeft;
  return padLeft + scaled * ratio - cursorX;
}
