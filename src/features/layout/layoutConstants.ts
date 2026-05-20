import type { RegionId } from "./layoutTypes";

/** region content 最小幅/高さ (px) */
export const MIN_REGION_SIZE = 120;

/** 中央エディタの実効最小幅 (px) — Splitter クランプ用 */
export const MIN_EDITOR_SIZE = 320;

/** stripe 固定幅/高さ (px) */
export const STRIPE_SIZE = 32;

/** ビューポートに対する region content 上限比率 */
export const MAX_REGION_SIZE_RATIO = 0.5;

/** 初回起動・リセット時の region content デフォルト (px) */
export const DEFAULT_REGION_SIZES: Record<RegionId, number> = {
  left: 260,
  right: 340,
  bottom: 220,
};

/** viewport から region ごとの最大 content サイズを算出 */
export function getMaxRegionSize(
  region: RegionId,
  viewport: { width: number; height: number },
): number {
  const axis = region === "bottom" ? viewport.height : viewport.width;
  return axis * MAX_REGION_SIZE_RATIO;
}

/** region content サイズを MIN〜MAX にクランプ */
export function clampRegionSize(
  region: RegionId,
  size: number,
  viewport: { width: number; height: number },
): number {
  const max = getMaxRegionSize(region, viewport);
  return Math.min(Math.max(size, MIN_REGION_SIZE), max);
}
