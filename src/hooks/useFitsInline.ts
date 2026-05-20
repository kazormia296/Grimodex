import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/**
 * Width-based responsive hook.
 *
 * Mounts a hidden `width: max-content` measure element next to a container.
 * Returns `fits` — true while the measured content can sit on a single line.
 *
 * When the visible content can't fit on a single line, callers should switch
 * to a grouped/compact representation. Mirrors the pattern used by
 * `ContextBar.tsx` for the chat panel context strip.
 *
 * Initial state is `true` so SSR / jsdom (where `clientWidth = 0`) keeps the
 * flat representation visible — important for tests that assert on individual
 * pill testids before any layout has run.
 */

// 一度 compact に畳んだら、明確に余裕ができるまで flat に戻さないための
// デッドゾーン。スクロールバーの出入り（〜17px）で container 幅が揺れても
// flat⇔compact が振動し、無限再レンダリング（Maximum update depth exceeded）
// に陥らないようにする。
const HYSTERESIS_PX = 24;

export function useFitsInline(): {
  containerRef: RefObject<HTMLDivElement | null>;
  measureRef: RefObject<HTMLDivElement | null>;
  fits: boolean;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(true);

  const check = useCallback(() => {
    const c = containerRef.current;
    const m = measureRef.current;
    if (!c || !m) return;
    const containerWidth = c.clientWidth;
    if (containerWidth === 0) return;
    const measureWidth = m.offsetWidth;
    setFits((prev) => {
      const next = prev
        ? measureWidth <= containerWidth
        : measureWidth <= containerWidth - HYSTERESIS_PX;
      return next === prev ? prev : next;
    });
  }, []);

  // 初回のみペイント前に同期計測してフラッシュを防ぐ。
  // check は安定参照なので、この effect は mount 時に一度だけ走る。
  useLayoutEffect(() => {
    check();
  }, [check]);

  // 以降のサイズ変化は ResizeObserver で拾う。container と measure の両方を
  // 監視することで、リサイズと props 変化（tag/alias の増減）の双方に追従する。
  // measure 要素は fits に依存せず常に full 表現を描画するため、これを監視しても
  // 切り替えによるフィードバックループは発生しない。
  useEffect(() => {
    const c = containerRef.current;
    const m = measureRef.current;
    if (!c) return;
    const ro = new ResizeObserver(check);
    ro.observe(c);
    if (m) ro.observe(m);
    return () => ro.disconnect();
  }, [check]);

  return { containerRef, measureRef, fits };
}
