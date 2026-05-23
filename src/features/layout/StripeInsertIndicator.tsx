import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { DragOverTarget } from "./layoutDnD";
import { useLayoutStore } from "./layoutStore";

function stripeOrientationForSegment(
  segmentEl: HTMLElement,
): "vertical" | "horizontal" {
  const stripeRoot = segmentEl.closest<HTMLElement>("[data-stripe-root]");
  const region = stripeRoot?.getAttribute("data-stripe-region");
  if (region === "bottom") return "horizontal";
  if (region === "center") return "horizontal";
  return "vertical";
}

/**
 * Insert line between stripe icons during reorder drag.
 * Pattern reference: leoweyr/react-ide-workspace-layout GlobalSideBar.renderIndicator
 * https://github.com/leoweyr/react-ide-workspace-layout
 */
export function StripeInsertIndicator() {
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const dragOverTarget = useLayoutStore((s) => s.dragOverTarget);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const [line, setLine] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (
      !draggingPanel ||
      layoutLocked ||
      !dragOverTarget ||
      dragOverTarget.type !== "stripe-reorder"
    ) {
      setLine(null);
      return;
    }

    function measure(
      target: Extract<DragOverTarget, { type: "stripe-reorder" }>,
    ) {
      const segmentEl = document.querySelector<HTMLElement>(
        `[data-drop-slot-id="${target.slotId}"]`,
      );
      if (!segmentEl) {
        setLine(null);
        return;
      }

      const orientation = stripeOrientationForSegment(segmentEl);

      const icons = segmentEl.querySelectorAll("[data-stripe-icon]");
      const insertIndex = Math.min(target.insertIndex, icons.length);

      if (icons.length === 0) {
        const rect = segmentEl.getBoundingClientRect();
        setLine({
          left: rect.left,
          top: rect.top,
          width: 2,
          height: rect.height,
        });
        return;
      }

      if (insertIndex >= icons.length) {
        const last = icons[icons.length - 1].getBoundingClientRect();
        if (orientation === "horizontal") {
          setLine({
            left: last.right,
            top: last.top + 2,
            width: 2,
            height: Math.max(0, last.height - 4),
          });
        } else {
          setLine({
            left: last.left + 2,
            top: last.bottom,
            width: Math.max(0, last.width - 4),
            height: 2,
          });
        }
        return;
      }

      const icon = icons[insertIndex].getBoundingClientRect();
      if (orientation === "horizontal") {
        setLine({
          left: icon.left - 1,
          top: icon.top + 2,
          width: 2,
          height: Math.max(0, icon.height - 4),
        });
      } else {
        setLine({
          left: icon.left + 2,
          top: icon.top - 1,
          width: Math.max(0, icon.width - 4),
          height: 2,
        });
      }
    }

    measure(dragOverTarget);

    const shell = document.querySelector("[data-layout-shell]");
    if (!shell) return;

    const observer = new ResizeObserver(() => {
      measure(dragOverTarget);
    });
    observer.observe(shell);

    return () => observer.disconnect();
  }, [dragOverTarget, draggingPanel, layoutLocked]);

  if (!line) return null;

  return createPortal(
    <div
      data-stripe-insert-indicator
      className="pointer-events-none fixed z-[9998] rounded-full bg-primary"
      style={{
        left: line.left,
        top: line.top,
        width: line.width,
        height: line.height,
        transition: "left 80ms ease, top 80ms ease",
      }}
    />,
    document.body,
  );
}
