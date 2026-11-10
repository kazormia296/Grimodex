import { useLayoutEffect, useRef, type RefObject } from "react";
import { LAYOUT_MOTION, useReducedMotion } from "@/lib/animation";
import { startClipReveal } from "@/features/layout/clipReveal";

/**
 * エディタの分割の開閉の動き。寸法はすぐに確定する（毎フレーム寸法を変えると、
 * 両方の欄の本文の折り返しを毎回やり直させる）。その上で clip を広げる。
 *
 * - 開く: 新しい欄を、分割の境界の辺から広げる。
 * - 閉じる: 広がった左（上）の欄を、直前の半分の矩形から広げる。
 *
 * 直前の矩形は測らずに求める（分割中の欄は w-1/2／h-1/2）。SceneEditor は
 * 頻繁に re-render されるので、commit ごとに測らない。
 *
 * 動かさないとき: 動きを減らす設定、Zen とスマートフォンの 1 欄表示（欄の
 * 切替を hidden で行う）、タブの状態の復元が終わる前（起動時の復元）。
 * 動き終えた状態に clip-path は残さない（startClipReveal が外す）。
 */
export function useEditorSplitReveal({
  primaryRef,
  secondaryRef,
  secondaryOpen,
  direction,
  enabled,
}: {
  primaryRef: RefObject<HTMLElement | null>;
  secondaryRef: RefObject<HTMLElement | null>;
  secondaryOpen: boolean;
  direction: "right" | "below";
  enabled: boolean;
}) {
  const reduced = useReducedMotion();
  const prevOpenRef = useRef(secondaryOpen);
  const prevEnabledRef = useRef(enabled);

  useLayoutEffect(() => {
    const wasOpen = prevOpenRef.current;
    const wasEnabled = prevEnabledRef.current;
    prevOpenRef.current = secondaryOpen;
    prevEnabledRef.current = enabled;
    if (wasOpen === secondaryOpen || !enabled || !wasEnabled || reduced) {
      return;
    }
    const target = secondaryOpen ? secondaryRef.current : primaryRef.current;
    if (!target) return;
    const last = target.getBoundingClientRect();
    if (last.width <= 0 || last.height <= 0) return;
    const first = secondaryOpen
      ? // 境界の辺（幅または高さが 0 の矩形）から。
        direction === "right"
        ? new DOMRect(last.left, last.top, 0, last.height)
        : new DOMRect(last.left, last.top, last.width, 0)
      : // 直前の半分から。
        direction === "right"
        ? new DOMRect(last.left, last.top, last.width / 2, last.height)
        : new DOMRect(last.left, last.top, last.width, last.height / 2);
    return startClipReveal(target, first, LAYOUT_MOTION.groupEnter);
  }, [secondaryOpen, direction, enabled, reduced, primaryRef, secondaryRef]);
}
