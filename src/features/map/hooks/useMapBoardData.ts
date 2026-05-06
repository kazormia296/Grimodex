import { useEffect, useState, useCallback } from "react";
import {
  getOrCreateBoard,
  listBoards,
  listNodePositions,
  listUserEdges,
  listFrames,
  listStickies,
  listAiBranches,
} from "../mapApi";
import { useMapStore } from "../mapStore";
import type { MapNodePositionRecord } from "../types";
import type {
  MapBoard,
  MapEdge,
  MapFrame,
  MapSticky,
  MapAiBranch,
} from "@/db/schema";

export function useMapBoardData(projectId: string) {
  const activeBoardId = useMapStore((s) => s.activeBoardId);
  const setActiveBoardId = useMapStore((s) => s.setActiveBoardId);

  const [boards, setBoards] = useState<MapBoard[]>([]);
  const [boardId, setBoardId] = useState<string | null>(activeBoardId);
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

  // Initial load: resolve boards and set active board
  useEffect(() => {
    let cancelled = false;
    async function init() {
      const allBoards = await reloadBoards();
      if (cancelled) return;

      // Honour stored activeBoardId if still valid
      const target =
        activeBoardId && allBoards.find((b) => b.id === activeBoardId)
          ? activeBoardId
          : (allBoards[0]?.id ?? null);

      if (!cancelled) setActiveBoardId(target);
    }
    init().catch(console.error);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Load board data whenever active board changes
  useEffect(() => {
    if (!activeBoardId) return;
    let cancelled = false;
    setBoardId(activeBoardId);

    async function load() {
      if (!activeBoardId) return;
      const [pos, ue, fr, st, ai] = await Promise.all([
        listNodePositions(activeBoardId),
        listUserEdges(activeBoardId),
        listFrames(activeBoardId),
        listStickies(activeBoardId),
        listAiBranches(activeBoardId),
      ]);
      if (cancelled) return;
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
  }, [activeBoardId]);

  return {
    boards,
    setBoards,
    boardId,
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
