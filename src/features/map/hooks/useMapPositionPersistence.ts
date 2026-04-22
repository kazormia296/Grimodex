import { useCallback } from "react";
import type {
  OnNodesChange,
  OnEdgesChange,
  NodeChange,
  Node,
} from "@xyflow/react";
import { applyNodeChanges } from "@xyflow/react";
import { toast } from "sonner";
import {
  upsertNodePosition,
  setNodePinned,
  updateFrame,
  deleteUserEdge,
} from "../mapApi";
import type { MapNodePositionRecord } from "../types";
import type { MapEdge, MapFrame } from "@/db/schema";
import { useKeyedDebouncedCallback } from "@/lib/useDebounce";

interface UseMapPositionPersistenceInput {
  boardId: string | null;
  mode: string;
  getNodes: () => Node[];
  setPositions: React.Dispatch<React.SetStateAction<MapNodePositionRecord[]>>;
  setFrames: React.Dispatch<React.SetStateAction<MapFrame[]>>;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setUserEdges: React.Dispatch<React.SetStateAction<MapEdge[]>>;
}

// Hoisted to keep `useKeyedDebouncedCallback`'s deps stable across renders.
const identityKey = (nodeId: string) => nodeId;

function reportPersistError(err: unknown) {
  // Unhandled IPC errors would otherwise surface as unhandledrejection and
  // leave the UI in an inconsistent state. Log + toast, swallow the rejection.

  console.error("[map] persistPosition failed", err);
  toast.error("位置の保存に失敗しました", { description: String(err) });
}

export function useMapPositionPersistence({
  boardId,
  mode,
  getNodes,
  setPositions,
  setFrames,
  setNodes,
  setUserEdges,
}: UseMapPositionPersistenceInput) {
  // persistPosition fires once per drag stop (per node). No debouncing here —
  // debouncing would delay setPositions/setFrames and create a window where
  // the `nodes` state (updated synchronously by applyNodeChanges) and the
  // `positions`/`frames` state are out of sync, causing snap-back visuals
  // when useMapNodes rebuilds from the stale positions.
  const persistPosition = useCallback(
    async (nodeId: string, x: number, y: number): Promise<void> => {
      if (!boardId) return;
      try {
        if (nodeId.startsWith("scene:")) {
          const treeNodeId = nodeId.slice("scene:".length);
          let updated = await upsertNodePosition({
            boardId,
            nodeRefType: "scene",
            treeNodeId,
            x,
            y,
          });
          // Hybrid: dragging in non-free mode auto-pins the node
          if (mode !== "free" && updated.pinned !== 1) {
            updated = (await setNodePinned(updated.id, true)) ?? updated;
          }
          setPositions((prev) => {
            const idx = prev.findIndex((p) => p.id === updated.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = updated as MapNodePositionRecord;
              return next;
            }
            return [...prev, updated as MapNodePositionRecord];
          });
        } else if (nodeId.startsWith("codex:")) {
          const codexEntryId = nodeId.slice("codex:".length);
          let updated = await upsertNodePosition({
            boardId,
            nodeRefType: "codex",
            codexEntryId,
            x,
            y,
          });
          if (mode !== "free" && updated.pinned !== 1) {
            updated = (await setNodePinned(updated.id, true)) ?? updated;
          }
          setPositions((prev) => {
            const idx = prev.findIndex((p) => p.id === updated.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = updated as MapNodePositionRecord;
              return next;
            }
            return [...prev, updated as MapNodePositionRecord];
          });
        } else if (nodeId.startsWith("note:")) {
          const treeNodeId = nodeId.slice("note:".length);
          const updated = await upsertNodePosition({
            boardId,
            nodeRefType: "note",
            treeNodeId,
            x,
            y,
          });
          setPositions((prev) => {
            const idx = prev.findIndex((p) => p.id === updated.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = updated as MapNodePositionRecord;
              return next;
            }
            return [...prev, updated as MapNodePositionRecord];
          });
        } else if (nodeId.startsWith("ai:")) {
          const aiNodeId = nodeId.slice("ai:".length);
          const updated = await upsertNodePosition({
            boardId,
            nodeRefType: "ai",
            aiNodeId,
            x,
            y,
          });
          setPositions((prev) => {
            const idx = prev.findIndex((p) => p.id === updated.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = updated as MapNodePositionRecord;
              return next;
            }
            return [...prev, updated as MapNodePositionRecord];
          });
        } else if (nodeId.startsWith("frame:")) {
          const frameId = nodeId.slice("frame:".length);
          // Read nodes at call time (not render time) so we always see the
          // current frame size even when the callback is stale-captured.
          const frameNode = getNodes().find((n) => n.id === nodeId);
          const w = (frameNode?.style?.width as number) ?? 400;
          const h = (frameNode?.style?.height as number) ?? 300;
          await updateFrame(frameId, { x, y, width: w, height: h });
          setFrames((prev) =>
            prev.map((f) => (f.id === frameId ? { ...f, x, y } : f)),
          );
        }
      } catch (err) {
        reportPersistError(err);
      }
    },
    [boardId, mode, getNodes, setFrames, setPositions],
  );

  const persistFrameResizeImpl = useCallback(
    async (nodeId: string, width: number, height: number) => {
      if (!nodeId.startsWith("frame:")) return;
      const frameId = nodeId.slice("frame:".length);
      try {
        await updateFrame(frameId, { width, height });
        setFrames((prev) =>
          prev.map((f) => (f.id === frameId ? { ...f, width, height } : f)),
        );
      } catch (err) {
        reportPersistError(err);
      }
    },
    [setFrames],
  );

  const persistFrameResize = useKeyedDebouncedCallback(
    persistFrameResizeImpl,
    500,
    identityKey,
  );

  const onNodesChange: OnNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
      for (const change of changes) {
        if (change.type === "position" && change.position && !change.dragging) {
          // persistPosition swallows its own errors, so no handler needed.
          void persistPosition(change.id, change.position.x, change.position.y);
        }
        if (change.type === "dimensions" && change.dimensions) {
          persistFrameResize(
            change.id,
            change.dimensions.width,
            change.dimensions.height,
          );
        }
      }
    },
    [persistPosition, persistFrameResize, setNodes],
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      for (const change of changes) {
        if (change.type === "remove" && change.id.startsWith("user:")) {
          const dbId = change.id.slice("user:".length);
          deleteUserEdge(dbId).catch(() => {});
          setUserEdges((prev) => prev.filter((e) => e.id !== dbId));
        }
      }
    },
    [setUserEdges],
  );

  return { onNodesChange, onEdgesChange, persistPosition };
}
