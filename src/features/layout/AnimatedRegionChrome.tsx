import { memo, useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/lib/animation";
import {
  chromeEnterTransition,
  chromeExitTransition,
  REGION_CLIP_PATH,
  REGION_TRANSFORM_ORIGIN,
  type RegionChromeId,
} from "./layoutAnimation";
import { useLayoutStore } from "./layoutStore";

interface AnimatedRegionChromeProps {
  region: RegionChromeId;
  open: boolean;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/** Region-level chrome collapse/expand via clip-path + opacity. */
export const AnimatedRegionChrome = memo(function AnimatedRegionChrome({
  region,
  open,
  children,
  className,
  style,
}: AnimatedRegionChromeProps) {
  const reduced = useReducedMotion();
  const initialized = useLayoutStore((state) => state.initialized);
  const clip = REGION_CLIP_PATH[region];
  // initializeLayout() と同じ render で閉じた region が開く場合、その enter は
  // ユーザー操作ではなく起動 hydration。最終状態を静的に表示し、初期化完了後の
  // toggle だけをアニメーションする。ref は次回の open render で効けばよいので、
  // readiness 更新自体による余分な render は不要。
  const animationReadyRef = useRef(initialized);
  useEffect(() => {
    if (initialized) animationReadyRef.current = true;
  }, [initialized]);
  const animateEntry = !reduced && animationReadyRef.current;

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key={`${region}-chrome`}
          data-animated-region={region}
          className={cn(
            "h-full w-full min-h-0 min-w-0 overflow-visible",
            className,
          )}
          style={{
            transformOrigin: REGION_TRANSFORM_ORIGIN[region],
            ...style,
          }}
          initial={animateEntry ? { opacity: 0, clipPath: clip.closed } : false}
          animate={{
            opacity: 1,
            clipPath: clip.open,
            // `inset(...)` 同士で enter を補間した後だけ clip を外す。
            // settled 状態に clip-path を残すと Backdrop Root が常設され、
            // 配下の Glass が ambient shader まで blur できなくなる。
            transitionEnd: { clipPath: "none" },
          }}
          exit={
            reduced
              ? undefined
              : {
                  opacity: 0,
                  clipPath: clip.closed,
                  transition: chromeExitTransition(reduced),
                }
          }
          transition={chromeEnterTransition(reduced)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
});
