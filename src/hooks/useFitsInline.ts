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
 * Returns `fits = (measure.offsetWidth <= container.clientWidth)`.
 *
 * When the visible content can't fit on a single line, callers should switch
 * to a grouped/compact representation. Mirrors the pattern used by
 * `ContextBar.tsx` for the chat panel context strip.
 *
 * Initial state is `true` so SSR / jsdom (where `clientWidth = 0`) keeps the
 * flat representation visible — important for tests that assert on individual
 * pill testids before any layout has run.
 */
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
    if (c.clientWidth === 0) return;
    const ok = m.offsetWidth <= c.clientWidth;
    setFits((prev) => (prev === ok ? prev : ok));
  }, []);

  useLayoutEffect(() => {
    check();
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [check]);

  return { containerRef, measureRef, fits };
}
