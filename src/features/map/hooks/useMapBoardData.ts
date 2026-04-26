import { useEffect, useState } from "react";
import {
  getOrCreateBoard,
  listAllNodePositions,
  listUserEdges,
  listFrames,
  listAINodes,
} from "../mapApi";
import type { MapNodePositionRecord } from "../types";
import type { MapEdge, MapFrame, MapAiNode } from "@/db/schema";

export function useMapBoardData(projectId: string) {
  const [boardId, setBoardId] = useState<string | null>(null);
  const [positions, setPositions] = useState<MapNodePositionRecord[]>([]);
  const [userEdges, setUserEdges] = useState<MapEdge[]>([]);
  const [frames, setFrames] = useState<MapFrame[]>([]);
  const [aiNodes, setAiNodes] = useState<MapAiNode[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const board = await getOrCreateBoard(projectId);
      if (cancelled) return;
      setBoardId(board.id);
      const [pos, ue, fr, ai] = await Promise.all([
        listAllNodePositions(board.id),
        listUserEdges(board.id),
        listFrames(board.id),
        listAINodes(board.id),
      ]);
      if (cancelled) return;
      setPositions(pos as MapNodePositionRecord[]);
      setUserEdges(ue);
      setFrames(fr);
      setAiNodes(ai);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return {
    boardId,
    positions,
    setPositions,
    userEdges,
    setUserEdges,
    frames,
    setFrames,
    aiNodes,
    setAiNodes,
  };
}
