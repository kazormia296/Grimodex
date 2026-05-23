import { memo, type ReactNode } from "react";
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
  const clip = REGION_CLIP_PATH[region];

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
          initial={reduced ? false : { opacity: 0, clipPath: clip.closed }}
          animate={{ opacity: 1, clipPath: clip.open }}
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
