import { useCallback, useRef, type ReactNode } from "react";

export interface SplitterHandleProps {
  orientation: "horizontal" | "vertical";
  disabled?: boolean;
  onDrag: (deltaPx: number) => void;
  onDragEnd?: () => void;
  children: ReactNode;
}

/**
 * Pointer drag logic for layout splitters (rAF-batched delta).
 */
export function SplitterHandle({
  orientation,
  disabled = false,
  onDrag,
  onDragEnd,
  children,
}: SplitterHandleProps) {
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

  // h-full w-full は必須: 親 (RegionContent / RegionResizeSplitter) は cross 軸を
  // flex stretch で渡し、main 軸を explicit px で与えるだけなので、SplitterHandle
  // 自身が full 寸法を取らないと SplitterChrome の `width: 100%` / `height: 100%`
  // の参照先が auto=0 に潰れ、splitter のヒット領域が 0 px になる。
  return (
    <div
      onPointerDown={handlePointerDown}
      data-splitter-handle
      className="h-full w-full"
    >
      {children}
    </div>
  );
}
