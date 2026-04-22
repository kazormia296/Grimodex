import { useCallback, useRef } from "react";

export function useDebouncedCallback<T extends unknown[]>(
  fn: (...args: T) => void,
  delay: number,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(
    (...args: T) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fn(...args), delay);
    },
    [fn, delay],
  );
}

/**
 * Per-key debounced callback. Each unique key maintains its own timer, so
 * rapid calls with different keys do not cancel each other. Use when the
 * same callback may fire for multiple distinct targets in quick succession
 * (e.g. persisting positions for several nodes after a group drag).
 */
export function useKeyedDebouncedCallback<T extends unknown[]>(
  fn: (...args: T) => void,
  delay: number,
  getKey: (...args: T) => string,
) {
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  return useCallback(
    (...args: T) => {
      const key = getKey(...args);
      const existing = timers.current.get(key);
      if (existing) clearTimeout(existing);
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          fn(...args);
        }, delay),
      );
    },
    [fn, delay, getKey],
  );
}
