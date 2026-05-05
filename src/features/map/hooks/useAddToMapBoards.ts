import { useCallback, useEffect, useState } from "react";
import { listBoards, upsertNodePosition } from "../mapApi";
import { useMapStore } from "../mapStore";
import type { MapBoard } from "@/db/schema";

export interface AddToMapEntity {
  nodeRefType: "scene" | "note" | "codex" | "snippet";
  treeNodeId?: string | null;
  codexEntryId?: string | null;
  snippetId?: string | null;
}

export function useAddToMapBoards(projectId: string) {
  const [boards, setBoards] = useState<MapBoard[]>([]);
  const viewport = useMapStore((s) => s.viewport);

  useEffect(() => {
    listBoards(projectId).then(setBoards).catch(console.error);
  }, [projectId]);

  const addToBoard = useCallback(
    async (boardId: string, entity: AddToMapEntity) => {
      // Approximate center of current viewport in flow coordinates
      const cx = (-viewport.x + window.innerWidth / 2) / viewport.zoom;
      const cy = (-viewport.y + window.innerHeight / 2) / viewport.zoom;
      const x = cx + (Math.random() - 0.5) * 120;
      const y = cy + (Math.random() - 0.5) * 120;
      await upsertNodePosition({ boardId, x, y, ...entity });
    },
    [viewport],
  );

  return { boards, setBoards, addToBoard };
}
