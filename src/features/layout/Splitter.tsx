import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

interface SplitterProps {
  /**
   * Drag axis: `horizontal` = vertical bar (col-resize, delta from clientX),
   * `vertical` = horizontal bar (row-resize, delta from clientY).
   */
  orientation: "horizontal" | "vertical";
  disabled?: boolean;
  onDrag: (deltaPx: number) => void;
  onDragEnd?: () => void;
  className?: string;
}

/**
 * Draggable divider between regions or slots.
 * deltaPx is positive when dragging toward increasing the preceding pane size.
 */
export function Splitter({
  orientation,
  disabled = false,
  onDrag,
  onDragEnd,
  className,
}: SplitterProps) {
  const onDragRef = useRef(onDrag);
  const onDragEndRef = useRef(onDragEnd);
  const pendingDeltaRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  onDragRef.current = onDrag;
  onDragEndRef.current = onDragEnd;

  const flushPendingDelta = useCallback(() => {
    rafRef.current = null;
    const delta = pendingDeltaRef.current;
    if (delta === 0) return;
    pendingDeltaRef.current = 0;
    onDragRef.current(delta);
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();

      const pointerId = e.pointerId;
      let lastPos = orientation === "horizontal" ? e.clientX : e.clientY;

      const handleMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const current = orientation === "horizontal" ? ev.clientX : ev.clientY;
        const delta = current - lastPos;
        if (delta === 0) return;
        lastPos = current;
        pendingDeltaRef.current += delta;
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(flushPendingDelta);
        }
      };

      const handleUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);

        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        if (pendingDeltaRef.current !== 0) {
          onDragRef.current(pendingDeltaRef.current);
          pendingDeltaRef.current = 0;
        }
        onDragEndRef.current?.();
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
    },
    [disabled, flushPendingDelta, orientation],
  );

  const isColumnDivider = orientation === "horizontal";

  return (
    <div
      role="separator"
      aria-orientation={isColumnDivider ? "vertical" : "horizontal"}
      data-layout-splitter={orientation}
      onPointerDown={handlePointerDown}
      className={cn(
        "relative z-20 shrink-0 touch-none select-none bg-border/80 hover:bg-primary/60 active:bg-primary/80",
        disabled && "pointer-events-none opacity-30",
        isColumnDivider
          ? "h-full w-1.5 min-w-1.5 cursor-col-resize"
          : "h-1.5 min-h-1.5 w-full cursor-row-resize",
        className,
      )}
    />
  );
}
