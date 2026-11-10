import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";

/** 入れ替わるアイコンを回す角度。状態の切替を伝える最小限の動き。 */
const SWAP_ROTATE_DEG = 90;

/**
 * ボタンのアイコンを、状態が変わったときだけ回しながら入れ替える
 * （DURATIONS.fast）。`swapKey` が変わったときだけ動き、mount 時は動かない。
 * 出ていくアイコンは重ねたまま消すので、ボタンの寸法は変わらない。
 */
export function AnimatedIconSwap({
  swapKey,
  children,
}: {
  swapKey: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const transition = reduced
    ? { duration: 0 }
    : { duration: DURATIONS.fast, ease: EASINGS.easeOut };
  return (
    <span className="relative inline-flex items-center justify-center">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={swapKey}
          className="inline-flex items-center justify-center"
          initial={
            reduced
              ? false
              : { opacity: 0, rotate: -SWAP_ROTATE_DEG, scale: 0.8 }
          }
          animate={{ opacity: 1, rotate: 0, scale: 1 }}
          exit={
            reduced
              ? { opacity: 0, transition: { duration: 0 } }
              : { opacity: 0, rotate: SWAP_ROTATE_DEG, scale: 0.8 }
          }
          transition={transition}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
