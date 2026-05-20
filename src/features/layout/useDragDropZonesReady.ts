import { useEffect, useState } from "react";

/**
 * Defer drop-zone overlays until after dragstart completes.
 * Mounting hit targets synchronously in onDragStart can cancel native HTML5 drag.
 */
export function useDragDropZonesReady(active: boolean): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!active) {
      setReady(false);
      return;
    }

    const frameId = requestAnimationFrame(() => {
      setReady(true);
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [active]);

  return ready;
}
