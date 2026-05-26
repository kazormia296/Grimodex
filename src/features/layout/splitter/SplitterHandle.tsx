import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";

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
  const handleRef = useRef<HTMLDivElement>(null);

  // Dev-only: ヒット領域が潰れていたら警告する。Splitter は flex/grid の
  // ネストで親寸法が見えなくなると width/height が 0 化しやすい (chrome の
  // `width: 100%` が auto=0 に解決される、h-full が flex main 軸を食い潰す、
  // 等)。grow_share=0 のような正当な「無いはず」のケースは disabled プロップで
  // 既に抑止されているので、ここで警告が出たら基本的にレイアウトのバグ。
  //
  // test 環境では browser invariant test 側で getBoundingClientRect を直接
  // 検証するので、ここでは出さない (vitest が console.warn を捕まえると React
  // Fiber ツリーまでシリアライズして出力が爆発する)。
  useLayoutEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.MODE === "test") return;
    if (disabled) return;
    const el = handleRef.current;
    if (!el) return;
    // 親が初回レイアウトを終えるまで 1 フレーム待つ。
    const id = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      const minHit = 4;
      if (r.width < minHit || r.height < minHit) {
        // el は console に渡さない (DevTools の Inspect で十分、Vitest の
        // console capture を巨大化させない)。
        console.warn(
          `[SplitterHandle] collapsed hit area: ${r.width.toFixed(1)}×${r.height.toFixed(1)}px (orientation=${orientation}). ` +
            `Parent must provide cross-axis stretch + main-axis explicit px. ` +
            `Common cause: chrome の % 寸法を解決できる sized 親が無い / h-full が flex main 軸を食い潰す。`,
        );
      }
    });
    return () => cancelAnimationFrame(id);
  });

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
      ref={handleRef}
      onPointerDown={handlePointerDown}
      data-splitter-handle
      className="w-full"
    >
      {children}
    </div>
  );
}
