import { useLayoutEffect, useRef } from "react";

export function useWorkLayerInitialFocus<T extends HTMLElement>(
  focusKey?: string,
) {
  const targetRef = useRef<T>(null);

  useLayoutEffect(() => {
    targetRef.current?.focus({ preventScroll: true });
  }, [focusKey]);

  return targetRef;
}
