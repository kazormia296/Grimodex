import { motion } from "motion/react";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";

/**
 * 速い読み込みでは出さない（チラつき防止）。この時間を過ぎても読み終わって
 * いなければ skeleton をフェードインする。
 */
const SKELETON_DELAY_S = 0.12;

/** 見出しと数行の本文の形。ループする動きは付けない（長時間の執筆で目障り）。 */
const ROW_WIDTHS = ["58%", "92%", "84%", "88%", "46%"] as const;

/**
 * lazy パネルの chunk を読み込んでいる間の面。中身の形だけを静かに見せて、
 * 「空の面が出てから一瞬で現れる」状態を避ける。
 */
export function PanelLoadingSkeleton() {
  const reduced = useReducedMotion();
  return (
    <motion.div
      data-panel-loading-skeleton
      aria-hidden
      className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-4"
      initial={reduced ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{
        delay: SKELETON_DELAY_S,
        duration: DURATIONS.normal,
        ease: EASINGS.easeOut,
      }}
    >
      {ROW_WIDTHS.map((width, index) => (
        <div
          key={index}
          className={
            index === 0
              ? "h-4 rounded-md bg-muted/70"
              : "h-3 rounded-md bg-muted/50"
          }
          style={{ width }}
        />
      ))}
    </motion.div>
  );
}
