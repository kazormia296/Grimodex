import { useEffect } from "react";
import { useMapStore } from "../mapStore";
import {
  serializeShowConfig,
  updateMapBoardSettings,
} from "../mapApi";

export const isBoardHydratingRef = { current: false };

function snapshotBoardSettings(state: ReturnType<typeof useMapStore.getState>) {
  return {
    activeBoardId: state.activeBoardId,
    mode: state.mode,
    viewport: state.viewport,
    show: state.show,
    colorBy: state.colorBy,
  };
}

let prevBoardSnapshot = JSON.stringify(
  snapshotBoardSettings(useMapStore.getState()),
);
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Reset debounce baseline after hydrate to avoid save loops. */
export function syncBoardPersistenceSnapshot() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  prevBoardSnapshot = JSON.stringify(
    snapshotBoardSettings(useMapStore.getState()),
  );
}

export function markBoardHydrating() {
  isBoardHydratingRef.current = true;
}

export function clearBoardHydrating() {
  queueMicrotask(() => {
    isBoardHydratingRef.current = false;
  });
}

export function useMapBoardPersistence() {
  useEffect(() => {
    const unsubscribe = useMapStore.subscribe((state) => {
      if (isBoardHydratingRef.current || !state.activeBoardId) return;

      const next = JSON.stringify(snapshotBoardSettings(state));
      if (next === prevBoardSnapshot) return;
      prevBoardSnapshot = next;

      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const current = useMapStore.getState();
        if (isBoardHydratingRef.current || !current.activeBoardId) return;
        try {
          await updateMapBoardSettings(current.activeBoardId, {
            mode: current.mode,
            viewportX: current.viewport.x,
            viewportY: current.viewport.y,
            viewportZoom: current.viewport.zoom,
            showConfig: serializeShowConfig(current.show),
            colorBy: current.colorBy,
          });
        } catch {
          // persistence errors are non-fatal
        }
      }, 600);
    });

    return () => {
      unsubscribe();
      if (saveTimer) clearTimeout(saveTimer);
    };
  }, []);
}
