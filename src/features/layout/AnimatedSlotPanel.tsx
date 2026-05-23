import { memo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { useReducedMotion, VARIANTS } from "@/lib/animation";
import type { ToolWindowPanelId } from "./layoutTypes";
import { chromeEnterTransition, chromeExitTransition } from "./layoutAnimation";
import { PANEL_COMPONENT_MAP } from "./panelComponents";
import { useLayoutStore } from "./layoutStore";

interface AnimatedSlotPanelProps {
  panelId: ToolWindowPanelId | null;
}

/**
 * Opacity-only: animated x/y/scale leaves a residual `transform: translate(0)`
 * inline that promotes the panel to a composited layer and breaks how
 * `.gx-panel`'s box-shadow blends into inter-panel gaps. Directional
 * entrance is owned by `AnimatedRegionChrome`'s clip-path.
 */
export const AnimatedSlotPanel = memo(function AnimatedSlotPanel({
  panelId,
}: AnimatedSlotPanelProps) {
  const reduced = useReducedMotion();
  const isDragging = useLayoutStore((s) =>
    panelId ? s.draggingPanel === panelId : false,
  );

  const Component = panelId ? PANEL_COMPONENT_MAP[panelId] : null;

  return (
    <AnimatePresence initial={false} mode="wait">
      {panelId && Component && (
        <motion.div
          key={panelId}
          data-slot-panel={panelId}
          data-animated-slot-panel={panelId}
          className={cn(
            "gx-panel glass-region-panel flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden",
            isDragging && "gx-panel--dragging",
          )}
          initial={reduced ? false : VARIANTS.fadeIn.initial}
          animate={VARIANTS.fadeIn.animate}
          exit={
            reduced
              ? undefined
              : {
                  ...VARIANTS.fadeIn.exit,
                  transition: chromeExitTransition(reduced),
                }
          }
          transition={chromeEnterTransition(reduced)}
        >
          <Component />
        </motion.div>
      )}
    </AnimatePresence>
  );
});
