import type { CSSProperties } from "react";
import { HORIZONTAL_STRIPE_SIZE } from "./layoutConstants";
import {
  CSS_EASINGS,
  DURATIONS,
  EASINGS,
  OVERLAY_DURATIONS,
} from "@/lib/animation";

export const PRESET_ANIMATION_DEBOUNCE_MS = 300;

/**
 * サイドと下のリージョンの引き出し（案 A）。寸法（grid の列・行）は即時に
 * 確定し、リージョンのカードを stripe 側の辺から滑り出させる／滑り込ませる。
 *
 * - `clip`: 滑っている間だけ外側の窓に掛ける clip-path。stripe 側の 1 辺だけを
 *   切り、残りの 3 辺は負の inset で panel の box-shadow を逃がす。settled 状態に
 *   clip-path を残すと Backdrop Root になり、配下の Glass が背後の ambient shader
 *   を blur できないので、動き終えたら必ず外す。
 * - `axis`／`sign`: カードを滑らせる向き。閉じた位置は sign × カードの寸法。
 * - `exitAnchor`: 閉じる間、列（行）は既に 0 になっている。カードを直前の寸法の
 *   まま absolute で center の上に重ね、stripe 側の辺に寄せる。
 */
export const REGION_DRAWER = {
  left: {
    clip: "inset(-200px -200px -200px 0px)",
    axis: "x",
    sign: -1,
    exitAnchor: { top: 0, left: 0 },
  },
  right: {
    clip: "inset(-200px 0px -200px -200px)",
    axis: "x",
    sign: 1,
    exitAnchor: { top: 0, right: 0 },
  },
  bottom: {
    clip: "inset(-200px -200px 0px -200px)",
    axis: "y",
    sign: 1,
    // 閉じた後の dock は stripe だけ。カードは stripe と stripe-gap の上に置く。
    exitAnchor: {
      left: 0,
      bottom: `calc(${HORIZONTAL_STRIPE_SIZE}px + var(--gx-stripe-gap))`,
    },
  },
} as const satisfies Record<
  string,
  {
    clip: string;
    axis: "x" | "y";
    sign: 1 | -1;
    exitAnchor: CSSProperties;
  }
>;

export type RegionChromeId = keyof typeof REGION_DRAWER;

/**
 * 起動時の hydration と同じ commit で mount された chrome は動かさない。
 * LayoutShell が `initialized` になった commit の後（effect）で true にし、
 * unmount（ワークスペースの切替）で false に戻す。mount 時に一度だけ読む。
 */
let layoutMotionReady = false;

export function setLayoutMotionReady(ready: boolean): void {
  layoutMotionReady = ready;
}

export function isLayoutMotionReady(): boolean {
  return layoutMotionReady;
}

export function chromeEnterTransition(reduced: boolean) {
  return reduced
    ? { duration: 0 }
    : { duration: DURATIONS.normal, ease: EASINGS.easeOut };
}

export function chromeExitTransition(reduced: boolean) {
  return reduced
    ? { duration: 0 }
    : { duration: DURATIONS.fast, ease: EASINGS.easeOut };
}

export function presetCrossfadeTransition(reduced: boolean) {
  return reduced
    ? { duration: 0 }
    : { duration: DURATIONS.fast, ease: EASINGS.easeOut };
}

/**
 * オーバーレイの開閉（平らなスライド）の CSS transition。開閉で時間は同じ。
 * Reduced Motion では transition 自体を外し、静的な最終状態に置き換える。
 * visibility は閉じるときだけスライドが終わるまで遅らせる（開くときは即座に見える）。
 */
export function overlaySlideTransitions(
  reduced: boolean,
  open: boolean,
): { panel: string; layer: string } {
  if (reduced) return { panel: "none", layer: "none" };
  const ms = `${OVERLAY_DURATIONS.slide * 1000}ms`;
  return {
    panel: `transform ${ms} ${CSS_EASINGS.easeOut}`,
    layer: `visibility 0ms linear ${open ? "0ms" : ms}`,
  };
}
