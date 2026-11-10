import { useLayoutEffect, useRef, type RefObject } from "react";
import { LAYOUT_MOTION, useReducedMotion } from "@/lib/animation";
import { startClipReveal } from "./clipReveal";
import type { BottomCornerOwnership, LayoutState } from "./layoutTypes";

const CORNER_TARGETS = {
  bottom: '[data-zoom-cell="bottom"]',
  left: '[data-region-stripe-column="left"]',
  right: '[data-region-stripe-column="right"]',
  leftContent: '[data-zoom-cell="left"]',
  rightContent: '[data-zoom-cell="right"]',
} as const;

type CornerTarget = keyof typeof CORNER_TARGETS;

/**
 * 下の角の取り合い（BottomCornerToggle）で、角を取った側の要素を直前の矩形から
 * clip で広げる（LAYOUT_MOTION.groupEnter）。寸法は即時に確定し、譲った側は
 * 即時に縮む。最大化の reveal と同じ clip の FLIP（startClipReveal）を使う。
 *
 * 直前の矩形はレイアウトが変わるたびに控える（store の変更は React の外で
 * 起きるので、変更前の DOM をイベント時点では測れない）。
 */
export function useCornerReveal(
  corners: BottomCornerOwnership,
  layout: LayoutState,
  shellRef: RefObject<HTMLDivElement | null>,
  motionReadyRef: RefObject<boolean>,
) {
  const reduced = useReducedMotion();
  const restRectsRef = useRef<Partial<Record<CornerTarget, DOMRect>>>({});
  const { left, right } = corners;
  const prevRef = useRef({ left, right });

  useLayoutEffect(() => {
    const prev = prevRef.current;
    const next = { left, right };
    prevRef.current = next;
    const shell = shellRef.current;
    if (!shell) return;
    const find = (target: CornerTarget) =>
      shell.querySelector<HTMLElement>(CORNER_TARGETS[target]);

    const cancels: Array<() => void> = [];
    if (!reduced && motionReadyRef.current) {
      for (const side of ["left", "right"] as const) {
        if (prev[side] === next[side]) continue;
        // side が角を取ると、stripe の列と content のセルの両方が下へ伸びる。
        const growers: CornerTarget[] = next[side]
          ? ["bottom"]
          : [side, side === "left" ? "leftContent" : "rightContent"];
        for (const grower of growers) {
          const el = find(grower);
          const first = restRectsRef.current[grower];
          if (el && first) {
            cancels.push(startClipReveal(el, first, LAYOUT_MOTION.groupEnter));
          }
        }
      }
    }

    // 次の切替の始点。clip は getBoundingClientRect に影響しない。
    for (const target of Object.keys(CORNER_TARGETS) as CornerTarget[]) {
      const el = find(target);
      if (el) restRectsRef.current[target] = el.getBoundingClientRect();
      else delete restRectsRef.current[target];
    }

    return () => {
      for (const cancel of cancels) cancel();
    };
  }, [left, right, layout, reduced, shellRef, motionReadyRef]);
}
