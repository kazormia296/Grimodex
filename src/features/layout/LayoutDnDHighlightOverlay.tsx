import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { CSS_DURATIONS } from "@/lib/animation";
import { getDropTargetRect, type DropTargetRect } from "./layoutDnD";
import { useLayoutStore } from "./layoutStore";
import { isReducedMotion } from "@/lib/gsap";

const RING_COLOR = "oklch(0.55 0.22 264)";
const GLOW_COLOR = "oklch(0.55 0.22 264 / 0.45)";

/** Highlights the active drop zone while a tool window panel is being dragged. */
export function LayoutDnDHighlightOverlay() {
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const dragOverTarget = useLayoutStore((s) => s.dragOverTarget);
  const layout = useLayoutStore((s) => s.layout);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const [rect, setRect] = useState<DropTargetRect | null>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef(dragOverTarget);

  targetRef.current = dragOverTarget;

  useLayoutEffect(() => {
    if (
      !draggingPanel ||
      layoutLocked ||
      !dragOverTarget ||
      dragOverTarget.type === "stripe-reorder"
    ) {
      setRect(null);
      return;
    }

    let rafId: number | null = null;

    function measure() {
      const target = targetRef.current;
      if (!target) {
        setRect(null);
        return;
      }
      setRect(getDropTargetRect(target, layout));
    }

    measure();

    const shell = document.querySelector("[data-layout-shell]");
    if (!shell) return;

    const observer = new ResizeObserver(() => {
      rafId = requestAnimationFrame(measure);
    });
    observer.observe(shell);

    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [dragOverTarget, draggingPanel, layout, layoutLocked]);

  useGSAP(
    () => {
      if (!highlightRef.current || isReducedMotion()) return;
      gsap.fromTo(
        highlightRef.current,
        { opacity: 1 },
        {
          opacity: 0.35,
          duration: 0.9,
          ease: "sine.inOut",
          yoyo: true,
          repeat: -1,
        },
      );
    },
    { dependencies: [rect] },
  );

  if (!draggingPanel || layoutLocked || !dragOverTarget || !rect) {
    return null;
  }

  return createPortal(
    <div
      data-dnd-highlight
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        pointerEvents: "none",
        zIndex: 9998,
        transition: `left ${CSS_DURATIONS.fast} ease, top ${CSS_DURATIONS.fast} ease, width ${CSS_DURATIONS.fast} ease, height ${CSS_DURATIONS.fast} ease`,
      }}
    >
      <div
        ref={highlightRef}
        className="h-full w-full"
        style={{
          borderRadius: 6,
          border: `2px dashed ${RING_COLOR}`,
          boxShadow: `0 0 16px 3px ${GLOW_COLOR}`,
          background: "oklch(0.55 0.22 264 / 0.08)",
        }}
      />
    </div>,
    document.body,
  );
}
