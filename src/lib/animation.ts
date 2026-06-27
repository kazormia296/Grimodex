import { useReducedMotion as useOsReducedMotion } from "motion/react";
import { useSettingsStore } from "@/features/settings/settingsStore";

export const DURATIONS = {
  fast: 0.15,
  normal: 0.2,
  slow: 0.3,
  dialog: 0.25,
} as const;

export const EASINGS = {
  easeOut: [0.16, 1, 0.3, 1] as [number, number, number, number],
  spring: { type: "spring" as const, damping: 25, stiffness: 300 },
} as const;

export const VARIANTS = {
  fadeIn: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
  },
  slideUp: {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 8 },
  },
  scaleIn: {
    initial: { opacity: 0, scale: 0.97 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.97 },
  },
  dropdown: {
    initial: { opacity: 0, y: -4 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -4 },
  },
  popover: {
    initial: { opacity: 0, scale: 0.95 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0 },
  },
} as const;

/**
 * 注意喚起の横揺れ (attention shake) の x キーフレーム。pending 中に離脱系操作が
 * ブロックされたとき InlineAIToolbar を一瞬揺らして視線を誘導する。べた書きを避け
 * 正本としてここに置く (Reduced Motion 時は呼び出し側で無効化する)。
 */
export const SHAKE_KEYFRAMES: number[] = [0, -6, 6, -5, 5, -3, 3, 0];

/** CSS transition-duration strings aligned with DURATIONS. */
export const CSS_DURATIONS = {
  fast: `${DURATIONS.fast * 1000}ms`,
  normal: `${DURATIONS.normal * 1000}ms`,
  slow: `${DURATIONS.slow * 1000}ms`,
  dialog: `${DURATIONS.dialog * 1000}ms`,
} as const;

/** CSS timing-function strings aligned with EASINGS（CSS transition 用）。 */
export const CSS_EASINGS = {
  easeOut: `cubic-bezier(${EASINGS.easeOut.join(", ")})`,
} as const;

/**
 * cubic-bezier(x1,y1,x2,y2) を評価する関数を返す。端点は (0,0)-(1,1) 固定。
 * CSS transition と同じ曲線を rAF などの命令的トゥイーンでも使うためのもの
 * （DURATIONS/EASINGS をべた書きの代わりに正本として使い回す）。
 * 引数 x は時間進捗 [0,1]、戻り値は値の進捗。
 */
export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // x（時間進捗）に対応する曲線パラメータ t を Newton 法で解く。
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-4) break;
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    return sampleY(t);
  };
}

/** EASINGS.easeOut と同一曲線の JS イージング関数（命令的トゥイーン用）。 */
export const easeOutFn = cubicBezier(...EASINGS.easeOut);

export function useReducedMotion(): boolean {
  const osReduced = useOsReducedMotion();
  const appReduced = useSettingsStore((s) =>
    s.getBoolean("display.reduceMotion", false),
  );
  return !!(osReduced || appReduced);
}
