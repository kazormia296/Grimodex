import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import {
  CSS_DURATIONS,
  HIGHLIGHT_PULSE_S,
  useReducedMotion,
} from "@/lib/animation";
import type { PanelId } from "./panelIds";
import { getPanelRect, queryPanelElement, type Rect } from "./panelRect";
import { isReducedMotion } from "@/lib/reducedMotion";

export { getPanelRect };

interface PanelHighlightOverlayProps {
  panelId: PanelId | null;
}

const RING_COLOR = "oklch(0.55 0.22 264)";
const GLOW_COLOR = "oklch(0.55 0.22 264 / 0.5)";

export function PanelHighlightOverlay({ panelId }: PanelHighlightOverlayProps) {
  const reduced = useReducedMotion();
  const [rect, setRect] = useState<Rect | null>(null);
  const [isExact, setIsExact] = useState(false);
  const highlightRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!panelId) {
      setRect(null);
      return;
    }

    let rafId: number | null = null;

    function measure() {
      if (!panelId) return;
      const el = queryPanelElement(panelId);
      setIsExact(!!el);
      setRect(getPanelRect(panelId));
    }

    measure();

    const target =
      queryPanelElement(panelId) ??
      document.querySelector("[data-layout-shell]");
    if (!target) return;

    const observer = new ResizeObserver(() => {
      rafId = requestAnimationFrame(measure);
    });
    observer.observe(target);
    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [panelId]);

  useGSAP(
    () => {
      if (!highlightRef.current || isReducedMotion()) return;
      gsap.fromTo(
        highlightRef.current,
        { opacity: 1 },
        {
          opacity: 0.3,
          duration: HIGHLIGHT_PULSE_S,
          ease: "sine.inOut",
          yoyo: true,
          repeat: -1,
        },
      );
    },
    { dependencies: [rect] },
  );

  if (!rect) return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        pointerEvents: "none",
        zIndex: 9999,
        transition: reduced
          ? "none"
          : `left ${CSS_DURATIONS.fast} ease, top ${CSS_DURATIONS.fast} ease, width ${CSS_DURATIONS.fast} ease, height ${CSS_DURATIONS.fast} ease`,
      }}
    >
      <div
        ref={highlightRef}
        className="h-full w-full"
        style={{
          borderRadius: 6,
          border: isExact
            ? `2.5px solid ${RING_COLOR}`
            : `2px dashed ${RING_COLOR}`,
          boxShadow: `0 0 18px 4px ${GLOW_COLOR}`,
          background: "transparent",
        }}
      />
    </div>,
    document.body,
  );
}
