import { useEffect } from "react";
import { useCurrentProjectId } from "@/features/project/projectStore";
import { useMapStore } from "../mapStore";
import { serializeShowConfig } from "../mapApi";
import {
  flushMapPersistenceWritesInBackground,
  scheduleMapBoardSettingsWrite,
} from "./mapPersistenceWriteQueue";

export const isBoardHydratingRef = { current: false };

function snapshotBoardSettings(state: ReturnType<typeof useMapStore.getState>) {
  return {
    activeBoardId: state.activeBoardId,
    mode: state.mode,
    viewport: { ...state.viewport },
    show: { ...state.show },
    colorBy: state.colorBy,
  };
}

let prevBoardSnapshot = snapshotBoardSettings(useMapStore.getState());
let prevBoardSnapshotJson = JSON.stringify(prevBoardSnapshot);

/**
 * Reset the observation baseline after hydrate without discarding a queued
 * write that belongs to the previously active board.
 */
export function syncBoardPersistenceSnapshot() {
  prevBoardSnapshot = snapshotBoardSettings(useMapStore.getState());
  prevBoardSnapshotJson = JSON.stringify(prevBoardSnapshot);
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
  const projectId = useCurrentProjectId();

  useEffect(() => {
    const unsubscribe = useMapStore.subscribe((state) => {
      const boardId = state.activeBoardId;
      if (isBoardHydratingRef.current || !boardId) return;

      const nextSnapshot = snapshotBoardSettings(state);
      const nextJson = JSON.stringify(nextSnapshot);
      if (nextJson === prevBoardSnapshotJson) return;
      const previous = prevBoardSnapshot;
      prevBoardSnapshot = nextSnapshot;
      prevBoardSnapshotJson = nextJson;

      // activeBoardId itself is stored in global settings, not on the board
      // row. Do not persist the previous board's mode/viewport into a newly
      // selected board before its hydrate completes.
      if (previous.activeBoardId !== nextSnapshot.activeBoardId) return;

      scheduleMapBoardSettingsWrite({
        projectId,
        boardId,
        settings: {
          mode: nextSnapshot.mode,
          viewportX: nextSnapshot.viewport.x,
          viewportY: nextSnapshot.viewport.y,
          viewportZoom: nextSnapshot.viewport.zoom,
          showConfig: serializeShowConfig(nextSnapshot.show),
          colorBy: nextSnapshot.colorBy,
        },
      });
    });

    return () => {
      unsubscribe();
      flushMapPersistenceWritesInBackground();
    };
  }, [projectId]);
}
