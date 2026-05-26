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

  // w-full は必須 (h-full は付けない):
  // - 親が flex-row な slot splitter (orientation="vertical" / 水平バー) では、
  //   SplitterHandle の main 軸 = width が auto = 0 に潰れ、内側 chrome の
  //   `width: 100%` が 0 になりヒット領域が消える。w-full で stretch を強制する。
  // - h-full を付けると、bottom region splitter のように flex-col 親に直接
  //   SplitterHandle が乗るケースで height: 100% が bottom grid cell 全体を
  //   占有してしまい、bottom region の content/stripe が押し出されて画面外に
  //   はみ出る。cross 軸はそれぞれの flex 方向で stretch されるので不要。
  return (
    <div
      onPointerDown={handlePointerDown}
      data-splitter-handle
      className="w-full"
    >
      {children}
    </div>
  );
}
