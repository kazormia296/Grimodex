import { motion } from "motion/react";
import { createPortal } from "react-dom";

import {
  EASINGS,
  useReducedMotion,
  WORK_LAYER_DURATIONS,
} from "@/lib/animation";

import { useWorkLayer } from "./WorkLayerContext";

export function AttentionArrivalGutter() {
  const workLayer = useWorkLayer();
  const reducedMotion = useReducedMotion();
  const anchor = workLayer?.model.attentionAnchorPosition;
  if (
    workLayer == null ||
    reducedMotion ||
    (workLayer.model.attentionDelta ?? 0) <= 0 ||
    workLayer.model.attentionAnchorVisible !== true ||
    anchor == null ||
    typeof document === "undefined"
  ) {
    return null;
  }

  const xPercent = Math.min(100, Math.max(0, anchor.xPercent));
  const yPercent = Math.min(100, Math.max(0, anchor.yPercent));
  const heightPx = Math.min(240, Math.max(3, anchor.heightPx));

  return createPortal(
    <motion.div
      data-testid="work-layer-arrival-gutter"
      aria-hidden="true"
      className="pointer-events-none fixed z-30 w-[3px] bg-foreground"
      style={{
        left: `${xPercent}%`,
        top: `${yPercent}%`,
        height: `${heightPx}px`,
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 0.3, 0] }}
      transition={{
        duration: WORK_LAYER_DURATIONS.arrival,
        ease: EASINGS.easeOut,
      }}
    />,
    document.body,
  );
}
