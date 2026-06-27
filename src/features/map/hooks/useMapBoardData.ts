import { useEffect, useState, useCallback } from "react";
import {
  getOrCreateBoard,
  getMapBoard,
  listBoards,
  listNodePositions,
  listUserEdges,
  listFrames,
  listStickies,
  listAiBranches,
} from "../mapApi";
import { useMapStore } from "../mapStore";
import {
  markBoardHydrating,
  clearBoardHydrating,
  syncBoardPersistenceSnapshot,
} from "./useMapBoardPersistence";
import type { MapNodePositionRecord } from "../types";
import type {
  MapBoard,
  MapEdge,
  MapFrame,
  MapSticky,
  MapAiBranch,
} from "@/db/schema";

/**
 * Pick which board to show for a project. Keep the stored board id only when
 * it belongs to the given board set (i.e. the current project); otherwise fall
 * back to the project's first board (or `null` when it has none). This is what
 * prevents a board carried over from a previously open project from sticking
 * around after a project switch.
 */
export function resolveActiveBoardId(
  storedBoardId: string | null,
  boards: { id: string }[],
): string | null {
  if (storedBoardId && boards.some((b) => b.id === storedBoardId)) {
    return storedBoardId;
  }
  return boards[0]?.id ?? null;
}

export function useMapBoardData(projectId: string) {
  const activeBoardId = useMapStore((s) => s.activeBoardId);
  const setActiveBoardId = useMapStore((s) => s.setActiveBoardId);
  const boardDataVersion = useMapStore((s) => s.boardDataVersion);

  const [boards, setBoards] = useState<MapBoard[]>([]);
  const [positions, setPositions] = useState<MapNodePositionRecord[]>([]);
  const [userEdges, setUserEdges] = useState<MapEdge[]>([]);
  const [frames, setFrames] = useState<MapFrame[]>([]);
  const [stickies, setStickies] = useState<MapSticky[]>([]);
  const [aiBranches, setAiBranches] = useState<MapAiBranch[]>([]);

  // Load all boards for this project
  const reloadBoards = useCallback(async () => {
    const allBoards = await listBoards(projectId);
    if (allBoards.length === 0) {
      const main = await getOrCreateBoard(projectId);
      setBoards([main]);
      return [main];
    }
    setBoards(allBoards);
    return allBoards;
  }, [projectId]);

  // Initial load / project switch: resolve boards and set the active board.
  // This hook is the *single authority* for activeBoardId per project — on a
  // project switch we drop the previous project's board/data and re-resolve
  // against THIS project's boards. (reloadProjectData deliberately no longer
  // nulls activeBoardId, which used to race this effect and leave the previous
  // project's board — or no board — selected.)
  useEffect(() => {
    let cancelled = false;
    // Drop the previous project's board data immediately so the canvas can't
    // keep showing a stale board while the new project's boards load.
    setBoards([]);
    setPositions([]);
    setUserEdges([]);
    setFrames([]);
    setStickies([]);
    setAiBranches([]);
    async function init() {
      const allBoards = await reloadBoards();
      if (cancelled) return;
      // Read activeBoardId fresh (not via a stale render closure): keep it only
      // when it belongs to this project, else fall back to the first board.
      const stored = useMapStore.getState().activeBoardId;
      const target = resolveActiveBoardId(stored, allBoards);
      if (!cancelled) setActiveBoardId(target);
    }
    init().catch(console.error);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Load board data whenever active board (or project) changes
  useEffect(() => {
    if (!activeBoardId) return;
    const boardId = activeBoardId;
    let cancelled = false;

    async function load() {
      const board = await getMapBoard(boardId);
      if (cancelled) return;
      // Guard against a board id carried over from another project (can happen
      // for one render during a project switch). Never hydrate another
      // project's board data into this project's canvas.
      if (!board || board.projectId !== projectId) return;

      const [pos, ue, fr, st, ai] = await Promise.all([
        listNodePositions(boardId),
        listUserEdges(boardId),
        listFrames(boardId),
        listStickies(boardId),
        listAiBranches(boardId),
      ]);
      if (cancelled) return;

      markBoardHydrating();
      useMapStore.getState().hydrateFromBoard(board);
      syncBoardPersistenceSnapshot();
      clearBoardHydrating();

      setPositions(pos as MapNodePositionRecord[]);
      setUserEdges(ue);
      setFrames(fr);
      setStickies(st);
      setAiBranches(ai);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [activeBoardId, boardDataVersion, projectId]);

  return {
    boards,
    setBoards,
    boardId: activeBoardId,
    reloadBoards,
    positions,
    setPositions,
    userEdges,
    setUserEdges,
    frames,
    setFrames,
    stickies,
    setStickies,
    aiBranches,
    setAiBranches,
  };
}
