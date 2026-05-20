import type { RegionId } from "./layoutTypes";

/** region content 最小幅/高さ (px) */
export const MIN_REGION_SIZE = 120;

/** open slot 間リサイズの最小幅/高さ (px) */
export const MIN_SLOT_SIZE = 40;

/** 中央エディタの実効最小幅 (px) — Splitter クランプ用 */
export const MIN_EDITOR_SIZE = 320;

/** stripe 固定幅/高さ (px) */
export const STRIPE_SIZE = 32;

/** region / slot 境界 Splitter の厚み (px) — Tailwind w-1.5 / h-1.5 と一致 */
export const SPLITTER_GUTTER_PX = 6;

/** DnD: content 端への新 slot 挿入ヒット領域 (px)。absolute 配置のためレイアウトに影響しない */
export const DND_NEW_SLOT_EDGE_HIT_PX = 64;

/** DnD: slot 間 / stripe divider への新 slot 挿入ヒット領域 (px, 境界からの半幅) */
export const DND_NEW_SLOT_BETWEEN_HALF_PX = 24;

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
