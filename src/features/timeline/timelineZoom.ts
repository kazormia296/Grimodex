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
