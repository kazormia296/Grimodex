import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { useLayoutStore, type PanelId } from "./layoutStore";
import { PANEL_REGION_MAP, type PanelRegion } from "./panelRegions";
import type { DockviewApi } from "dockview-react";
import { isReducedMotion } from "@/lib/gsap";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function estimateCodexQuickRect(api: DockviewApi): Rect | null {
  const container = document.querySelector(".dockview-theme-dark");
  if (!container) return null;
  const cr = container.getBoundingClientRect();

  const cqPanel = api.getPanel("codex-quick");
  const scenesPanel = api.getPanel("scenes");
  if (cqPanel?.group?.element && cqPanel.group !== scenesPanel?.group) {
    const r = cqPanel.group.element.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  if (scenesPanel?.group?.element) {
    const sr = scenesPanel.group.element.getBoundingClientRect();
    const bottom = cr.bottom;
    if (bottom > sr.bottom + 20) {
      return {
        left: sr.left,
        top: sr.bottom,
        width: sr.width,
        height: bottom - sr.bottom,
      };
    }
  }

  return {
    left: cr.left,
    top: cr.top + cr.height * 0.5,
    width: cr.width * 0.18,
    height: cr.height * 0.5,
  };
}

function estimateRegionRect(region: PanelRegion): Rect | null {
  const container = document.querySelector(".dockview-theme-dark");
  if (!container) return null;
  const r = container.getBoundingClientRect();

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
  const api = useLayoutStore.getState().dockviewApi;
  if (!api) return null;

  if (panelId === "codex-quick") return estimateCodexQuickRect(api);

  const panel = api.getPanel(panelId);
  if (panel?.group?.element) {
    const r = panel.group.element.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  if (panelId === "editor") return null;
  const region =
    panelId === "codex"
      ? "center-bottom"
      : PANEL_REGION_MAP[panelId as Exclude<PanelId, "editor">];
  return estimateRegionRect(region);
}

interface PanelHighlightOverlayProps {
  panelId: PanelId | null;
}

// Border color for the highlight ring
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
      const api = useLayoutStore.getState().dockviewApi;
      const panel = api?.getPanel(panelId);
      const exact = !!panel?.group?.element;
      setIsExact(exact);
      setRect(getPanelRect(panelId));
    }

    measure();

    const api = useLayoutStore.getState().dockviewApi;
    const panel = api?.getPanel(panelId);
    const target =
      panel?.group?.element ?? document.querySelector(".dockview-theme-dark");
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

  // Pulsing opacity animation — restarts whenever rect changes (new step)
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
        transition:
          "left 150ms ease, top 150ms ease, width 150ms ease, height 150ms ease",
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
