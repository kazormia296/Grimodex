import type { RegionId } from "./layoutTypes";

/** region content 最小幅/高さ (px) */
export const MIN_REGION_SIZE = 120;

/** open slot 間リサイズの最小幅/高さ (px) */
export const MIN_SLOT_SIZE = 40;

/** 中央エディタの実効最小幅 (px) — Splitter クランプ用 */
export const MIN_EDITOR_SIZE = 320;

/** stripe 固定幅/高さ (px) */
export const STRIPE_SIZE = 32;

/**
 * Card layout (D案) — 構造ギャップ。階層 outer > stripe > panel が重要。
 * CSS 側の --gx-outer-pad / --gx-stripe-gap / --gx-panel-gap と一致させること。
 */
/** ウィンドウ外周 → stripe の内側余白 (px) */
export const OUTER_PAD_PX = 14;
/** stripe 間 / stripe ↔ center のギャップ (px) */
export const STRIPE_GAP_PX = 12;
/** 同一 stripe 内のパネル間ギャップ (px) */
export const PANEL_GAP_PX = 10;

/**
 * region 境界 Splitter（resize ハンドル）の厚み (px) — カードレイアウト ON 時。
 * D案ではこの帯が stripe 間ギャップそのものになる（線は描かない）。
 */
export const SPLITTER_GUTTER_PX = STRIPE_GAP_PX;

/** 旧レイアウト（カードレイアウト OFF）の Splitter 実線の厚み (px)。 */
export const LEGACY_SPLITTER_PX = 6;

/** カードレイアウト ON/OFF に応じた region 境界 Splitter 帯の幅。 */
export function regionSplitterPx(cardLayout: boolean): number {
  return cardLayout ? SPLITTER_GUTTER_PX : LEGACY_SPLITTER_PX;
}

/** カードレイアウト ON/OFF に応じた同一 region 内スロット間 Splitter 帯の幅。 */
export function slotSplitterPx(cardLayout: boolean): number {
  return cardLayout ? PANEL_GAP_PX : LEGACY_SPLITTER_PX;
}

/** DnD: content 端への新 slot 挿入ヒット領域 (px)。absolute 配置のためレイアウトに影響しない */
export const DND_NEW_SLOT_EDGE_HIT_PX = 64;

/** DnD: slot 間 / stripe divider への新 slot 挿入ヒット領域 (px, 境界からの半幅) */
export const DND_NEW_SLOT_BETWEEN_HALF_PX = 24;

/** Stripe icon pointer drag: long-press before drag mode (desktop fallback). */
export const STRIPE_DRAG_LONG_PRESS_MS = 250;

/** Stripe pointer hit-test padding beyond stripe bounds (px). */
export const STRIPE_DRAG_DETECTION_PAD_PX = 24;

/** Off-axis movement before stripe drag escapes axis-lock swap mode (px). */
export const STRIPE_SWAP_AXIS_LOCK_PX = 120;

/** gap-0.5 between stripe icons — used for axis-lock slot size math. */
export const STRIPE_ICON_GAP_PX = 2;

/** ビューポートに対する region content 上限比率 */
export const MAX_REGION_SIZE_RATIO = 0.5;

/** 初回起動・リセット時の region content デフォルト (px) */
export const DEFAULT_REGION_SIZES: Record<RegionId, number> = {
  left: 260,
  right: 340,
  bottom: 220,
};

/** region サイズクランプ用のレイアウト文脈（filler 時の上限緩和など） */
export interface RegionSizeClampContext {
  centerBandVisible: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  hasLeft: boolean;
  hasRight: boolean;
  leftSize: number;
  rightSize: number;
  /** center band 表示時に side region から確保する最小幅合計 */
  centerReserve: number;
  /** カードレイアウト ON/OFF。未指定時は ON 扱い。 */
  cardLayout?: boolean;
}

/**
 * center band 非表示時に 1fr で余白を吸収する side region。
 * `layoutMetrics.computeLayoutGridMetrics` と同じ優先順位。
 */
export function computeFillerRegion(input: {
  centerBandVisible: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
}): "left" | "right" | null {
  if (input.centerBandVisible) return null;
  if (input.rightOpen) return "right";
  if (input.leftOpen) return "left";
  return null;
}

function horizontalResizeChromePx(
  context: RegionSizeClampContext,
  fillerRegion: "left" | "right" | null,
): number {
  const cardLayout = context.cardLayout ?? true;
  const splitterPx = regionSplitterPx(cardLayout);
  const gapPx = cardLayout ? STRIPE_GAP_PX : 0;
  // 外周パディング (左右) — カードレイアウト時のみレイアウト幅を消費する。
  let chrome = cardLayout ? OUTER_PAD_PX * 2 : 0;
  // stripe 本体 + その stripe ↔ content 間ギャップ列。
  if (context.hasLeft) chrome += STRIPE_SIZE + gapPx;
  if (context.hasRight) chrome += STRIPE_SIZE + gapPx;
  // content ↔ editor 境界の splitter 帯（filler 側は境界を持たない）。
  if (context.leftOpen && fillerRegion !== "left") chrome += splitterPx;
  if (context.rightOpen && fillerRegion !== "right") chrome += splitterPx;
  return chrome;
}

/** viewport から region ごとの最大 content サイズを算出 */
export function getMaxRegionSize(
  region: RegionId,
  viewport: { width: number; height: number },
  context?: RegionSizeClampContext,
): number {
  const axis = region === "bottom" ? viewport.height : viewport.width;
  const defaultMax = axis * MAX_REGION_SIZE_RATIO;

  if (!context || region === "bottom") return defaultMax;

  if (context.centerBandVisible) {
    const chrome = horizontalResizeChromePx(context, null);
    const maxHorizontal = Math.max(
      0,
      viewport.width - chrome - context.centerReserve,
    );
    if (region === "left") {
      const other = context.rightOpen ? context.rightSize : 0;
      return Math.max(MIN_REGION_SIZE, maxHorizontal - other);
    }
    if (region === "right") {
      const other = context.leftOpen ? context.leftSize : 0;
      return Math.max(MIN_REGION_SIZE, maxHorizontal - other);
    }
  }

  const fillerRegion = computeFillerRegion({
    centerBandVisible: context.centerBandVisible,
    leftOpen: context.leftOpen,
    rightOpen: context.rightOpen,
  });
  if (!fillerRegion) return defaultMax;

  const chrome = horizontalResizeChromePx(context, fillerRegion);

  // filler ではない固定側: 相手 region の最小幅を残してほぼ全幅まで伸ばせる
  if (fillerRegion === "right" && region === "left" && context.leftOpen) {
    return Math.max(MIN_REGION_SIZE, viewport.width - chrome - MIN_REGION_SIZE);
  }
  if (fillerRegion === "left" && region === "right" && context.rightOpen) {
    return Math.max(MIN_REGION_SIZE, viewport.width - chrome - MIN_REGION_SIZE);
  }

  return defaultMax;
}

/** region content サイズを MIN〜MAX にクランプ */
export function clampRegionSize(
  region: RegionId,
  size: number,
  viewport: { width: number; height: number },
  context?: RegionSizeClampContext,
): number {
  const max = getMaxRegionSize(region, viewport, context);
  return Math.min(Math.max(size, MIN_REGION_SIZE), max);
}
