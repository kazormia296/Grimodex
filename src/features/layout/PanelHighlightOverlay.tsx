import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { CSS_DURATIONS } from "@/lib/animation";
import type { PanelId } from "./panelIds";
import { PANEL_REGION_MAP, type PanelRegion } from "./panelRegions";
import { isReducedMotion } from "@/lib/gsap";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function queryPanelElement(panelId: PanelId): Element | null {
  if (panelId === "editor") {
    return document.querySelector("[data-editor-area]");
  }
  return document.querySelector(`[data-slot-panel="${panelId}"]`);
}

function estimateRegionRect(region: PanelRegion): Rect | null {
  const shell = document.querySelector("[data-layout-shell]");
  if (!shell) return null;
  const r = shell.getBoundingClientRect();

  switch (region) {
    case "left":
      return {
        left: r.left,
        top: r.top,
        width: r.width * 0.18,
        height: r.height,
      };
    case "right":
      return {
        left: r.left + r.width * 0.7,
        top: r.top,
        width: r.width * 0.3,
        height: r.height,
      };
    case "center-bottom":
      return {
        left: r.left + r.width * 0.18,
        top: r.top + r.height * 0.6,
        width: r.width * 0.52,
        height: r.height * 0.4,
      };
  }
}

export function getPanelRect(panelId: PanelId): Rect | null {
  const el = queryPanelElement(panelId);
  if (el) {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  if (panelId === "editor") return null;
  const region = PANEL_REGION_MAP[panelId as Exclude<PanelId, "editor">];
  return estimateRegionRect(region);
}

interface PanelHighlightOverlayProps {
  panelId: PanelId | null;
}

const RING_COLOR = "oklch(0.55 0.22 264)";
const GLOW_COLOR = "oklch(0.55 0.22 264 / 0.5)";

export function PanelHighlightOverlay({ panelId }: PanelHighlightOverlayProps) {
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
          duration: 0.9,
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
        transition: `left ${CSS_DURATIONS.fast} ease, top ${CSS_DURATIONS.fast} ease, width ${CSS_DURATIONS.fast} ease, height ${CSS_DURATIONS.fast} ease`,
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
