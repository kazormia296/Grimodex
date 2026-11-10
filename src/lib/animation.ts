import { useReducedMotion as useOsReducedMotion } from "motion/react";
import { useSettingsStore } from "@/features/settings/settingsStore";

export const DURATIONS = {
  fast: 0.15,
  normal: 0.2,
  slow: 0.3,
  dialog: 0.25,
} as const;

/** Work Layer の一度きりの状態通知。本文ではなくheader chromeだけに使う。 */
export const WORK_LAYER_DURATIONS = {
  arrival: 1.2,
  resolution: 1.5,
} as const;

/** Zen の背景だけに使う、知覚しにくい長周期モーション。 */
export const ZEN_AMBIENT_DURATIONS = {
  enter: 0.8,
  exit: 0.45,
  primaryDrift: 72,
  secondaryDrift: 88,
} as const;

/**
 * 画面端のオーバーレイの開閉。平らなスライドだけ（3D は P2）。
 * 開閉で時間を変えない（設計メモ §3.4 の初期値）。
 */
export const OVERLAY_DURATIONS = {
  slide: 0.3,
} as const;

/**
 * レイアウト（リージョン・slot・パネル切替・プリセット）の動き。
 * 既存の DURATIONS の値域から選ぶ。退場は入場より速くする。
 * - region*: サイドと下のリージョンの引き出し（stripe の裏から滑り出る）
 * - group*: リージョン内の slot、stripe の band、center の segment の開閉
 * - morph: プリセット切替・最大化の解除で、カードの外形を旧矩形から新矩形へ動かす
 * - contentIn: 外形が着いた後に中身を見せるフェード
 * - panelShiftPx: パネル切替で入る側を寄せる距離（パネル内側の wrapper だけ）
 * - stripeShiftPx: stripe が新しく現れるとき、外側から寄せる距離
 */
export const LAYOUT_MOTION = {
  regionEnter: DURATIONS.slow,
  regionExit: DURATIONS.normal,
  groupEnter: DURATIONS.normal,
  groupExit: DURATIONS.fast,
  morph: DURATIONS.slow,
  contentIn: DURATIONS.fast,
  panelShiftPx: 6,
  stripeShiftPx: 8,
} as const;

export const EASINGS = {
  easeOut: [0.16, 1, 0.3, 1] as [number, number, number, number],
  spring: { type: "spring" as const, damping: 25, stiffness: 300 },
} as const;

/**
 * エディタのタブの動き。
 * - spring: タブの開閉。共有の EASINGS.spring より速く軽い（タブは小さく、
 *   頻繁に開け閉めする）。
 * - indicator: アクティブの下線が隣のタブへ滑る。
 * - reorderS: 並べ替えの後、動いたタブが旧位置から滑る長さ（秒）。
 */
export const TAB_MOTION = {
  spring: { type: "spring" as const, damping: 22, stiffness: 380, mass: 0.7 },
  indicator: { duration: DURATIONS.normal, ease: EASINGS.easeOut },
  reorderS: DURATIONS.normal,
} as const;

/** 位置を知らせるハイライトの点滅の半周期（GSAP の yoyo、秒）。 */
export const HIGHLIGHT_PULSE_S = 0.9;

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
  /**
   * 着地の小さな弾み（WAAPI 用。EASINGS.spring の代わり）。わずかに行き過ぎて
   * 戻る。跳ねる系なので、パネルの移動の着地のような稀な操作にだけ使う。
   */
  settle: "cubic-bezier(0.34, 1.4, 0.64, 1)",
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
