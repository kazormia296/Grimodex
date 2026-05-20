import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

interface SplitterProps {
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
  const dragging = useRef(false);
  const startPos = useRef(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      dragging.current = true;
      startPos.current = orientation === "horizontal" ? e.clientX : e.clientY;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [disabled, orientation],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const current = orientation === "horizontal" ? e.clientX : e.clientY;
      const delta = current - startPos.current;
      startPos.current = current;
      onDrag(delta);
    },
    [onDrag, orientation],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      onDragEnd?.();
    },
    [onDragEnd],
  );

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className={cn(
        "z-10 shrink-0 touch-none bg-border/60 hover:bg-primary/40 active:bg-primary/60",
        disabled && "pointer-events-none opacity-30",
        orientation === "horizontal"
          ? "w-1 cursor-col-resize"
          : "h-1 cursor-row-resize",
        className,
      )}
    />
  );
}
