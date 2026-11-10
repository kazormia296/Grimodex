import { useLayoutEffect, useRef, type RefObject } from "react";
import { CSS_EASINGS, LAYOUT_MOTION } from "@/lib/animation";
import { SETTINGS_CATEGORIES, type SettingsCategory } from "./types";

/**
 * 設定のカテゴリを切り替えたとき、本文をパネルの切替と同じく
 * LAYOUT_MOTION.panelShiftPx 寄せて出す（カテゴリの並びで先へ進めば下から、
 * 戻れば上から）。ダイアログを開いた（scope が変わった）切替では動かさない。
 * WAAPI で動かすので、終われば inline の transform は残らない。
 */
export function useCategoryShift(
  ref: RefObject<HTMLElement | null>,
  category: SettingsCategory,
  scope: number,
  reduced: boolean,
) {
  const prevRef = useRef({ category, scope });
  useLayoutEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { category, scope };
    if (prev.scope !== scope || prev.category === category || reduced) return;
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    const order = SETTINGS_CATEGORIES.map(({ id }) => id);
    const sign =
      order.indexOf(category) > order.indexOf(prev.category) ? 1 : -1;
    const animation = el.animate(
      [
        { transform: `translateY(${sign * LAYOUT_MOTION.panelShiftPx}px)` },
        { transform: "none" },
      ],
      {
        duration: LAYOUT_MOTION.groupEnter * 1000,
        easing: CSS_EASINGS.easeOut,
      },
    );
    return () => animation.cancel();
  }, [ref, category, scope, reduced]);
}
