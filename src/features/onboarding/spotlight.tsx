import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getPanelRect } from "@/features/layout/PanelHighlightOverlay";
import type { PanelId } from "@/features/layout/layoutStore";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function buildFocusClipPath(rect: Rect, vw: number, vh: number): string {
  const { left, top, width, height } = rect;
  return (
    `path(evenodd, 'M 0 0 H ${vw} V ${vh} H 0 Z ` +
    `M ${left} ${top} H ${left + width} V ${top + height} H ${left} Z')`
  );
}

interface SpotlightOverlayProps {
  panelId: PanelId | null;
}

export function SpotlightOverlay({ panelId }: SpotlightOverlayProps) {
  const [focusRect, setFocusRect] = useState<Rect | null>(null);
  const [vw, setVw] = useState(0);
  const [vh, setVh] = useState(0);
  const [visible, setVisible] = useState(false);

  useLayoutEffect(() => {
    requestAnimationFrame(() => setVisible(true));

    function measure() {
      setVw(window.innerWidth);
      setVh(window.innerHeight);
      if (!panelId) {
        setFocusRect(null);
        return;
      }
      setFocusRect(getPanelRect(panelId));
    }

    measure();

    const container = document.querySelector(".dockview-theme-dark");
    const observer = new ResizeObserver(measure);
    if (container) observer.observe(container);
    window.addEventListener("resize", measure);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [panelId]);

  const clipPath =
    focusRect && vw && vh ? buildFocusClipPath(focusRect, vw, vh) : undefined;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        pointerEvents: "none",
        background: "oklch(0 0 0 / 0.4)",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.35s ease, clip-path 0.25s ease",
        clipPath,
      }}
    />,
    document.body,
  );
}
