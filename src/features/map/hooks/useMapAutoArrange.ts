import { useCallback } from "react";
import { upsertNodePosition, listAllNodePositions } from "../mapApi";
import {
  autoArrange,
  autoArrangeForceDirected,
  type AutoArrangeType,
} from "../layouts/autoArrange";
import { WorkerForceLayoutEngine } from "../layouts/forceEngine";
import type { MapNodePositionRecord, MapMode } from "../types";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntry } from "@/features/codex/api";

interface UseMapAutoArrangeInput {
  boardId: string | null;
  pendingAutoArrange: AutoArrangeType | null;
  positions: MapNodePositionRecord[];
  treeNodes: TreeNodeData[];
  codexEntries: CodexEntry[];
  variant: "compact" | "card" | "image";
  setPositions: React.Dispatch<React.SetStateAction<MapNodePositionRecord[]>>;
  setForceLayoutRunning: (v: boolean) => void;
  setForceAlpha: (v: number) => void;
  setPendingAutoArrange: (type: AutoArrangeType | null) => void;
  setMode: (mode: MapMode) => void;
}

export function useMapAutoArrange({
  boardId,
  pendingAutoArrange,
  positions,
  treeNodes,
  codexEntries,
  variant,
  setPositions,
  setForceLayoutRunning,
  setForceAlpha,
  setPendingAutoArrange,
  setMode,
}: UseMapAutoArrangeInput) {
  const executeAutoArrange = useCallback(async () => {
    if (!pendingAutoArrange || !boardId) return;
    const type = pendingAutoArrange;
    setPendingAutoArrange(null);

    const hiddenSceneIds = new Set(
      positions
        .filter((p) => p.hidden === 1 && p.treeNodeId)
        .map((p) => p.treeNodeId!),
    );
    const hiddenCodexIds = new Set(
      positions
        .filter((p) => p.hidden === 1 && p.codexEntryId)
        .map((p) => p.codexEntryId!),
    );
    const scenes = treeNodes.filter(
      (n) => n.nodeType === "scene" && !hiddenSceneIds.has(n.id),
    );
    const visibleCodex = codexEntries.filter((e) => !hiddenCodexIds.has(e.id));
    const pinnedIds = new Set(
      positions
        .filter((p) => p.pinned === 1 && p.treeNodeId)
        .map((p) => p.treeNodeId!),
    );

    let newPositions;
    if (type === "force-directed") {
      setForceLayoutRunning(true);
      setForceAlpha(1);
      const engine = new WorkerForceLayoutEngine();
      newPositions = await autoArrangeForceDirected(
        { scenes, codexEntries: visibleCodex, positions },
        engine,
        pinnedIds,
        (alpha) => setForceAlpha(alpha),
      );
      setForceLayoutRunning(false);
    } else {
      newPositions = autoArrange({
        type,
        allTreeNodes: treeNodes,
        scenes,
        positions,
        variant,
      });
    }

    await Promise.all(
      Array.from(newPositions.entries()).map(([key, pos]) => {
        if (key.startsWith("scene:")) {
          return upsertNodePosition({
            boardId,
            nodeRefType: "scene",
            treeNodeId: key.slice("scene:".length),
            x: pos.x,
            y: pos.y,
          });
        }
        return Promise.resolve(undefined);
      }),
    );

    const refreshed = await listAllNodePositions(boardId);
    setPositions(refreshed as MapNodePositionRecord[]);
    setMode("free");
  }, [
    pendingAutoArrange,
    boardId,
    treeNodes,
    codexEntries,
    positions,
    variant,
    setPositions,
    setForceLayoutRunning,
    setForceAlpha,
    setPendingAutoArrange,
    setMode,
  ]);

  return { executeAutoArrange };
}
