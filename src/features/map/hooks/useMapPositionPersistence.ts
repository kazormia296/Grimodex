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
  persistingRef: React.MutableRefObject<Set<string>>;
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
  persistingRef,
}: UseMapPositionPersistenceInput) {
  // persistPosition fires once per drag stop (per node). No debouncing here —
  // debouncing would delay setPositions/setFrames and create a window where
  // the `nodes` state (updated synchronously by applyNodeChanges) and the
  // `positions`/`frames` state are out of sync, causing snap-back visuals
  // when useMapNodes rebuilds from the stale positions.
  //
  // Even without debouncing, the IPC round-trip to SQLite still creates that
  // window. `persistingRef` tracks ids during that window so useMapNodes can
  // preserve the live (post-drop) position from `prev` instead of falling
  // back to the stale computed position.
  const persistPosition = useCallback(
    async (nodeId: string, x: number, y: number): Promise<void> => {
      if (!boardId) return;
      persistingRef.current.add(nodeId);
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
        } else if (nodeId.startsWith("snippet:")) {
          const snippetId = nodeId.slice("snippet:".length);
          const updated = await upsertNodePosition({
            boardId,
            nodeRefType: "snippet",
            snippetId,
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
        } else if (nodeId.startsWith("sticky:")) {
          const stickyId = nodeId.slice("sticky:".length);
          const updated = await upsertNodePosition({
            boardId,
            nodeRefType: "sticky",
            stickyId,
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
        } else if (nodeId.startsWith("ai_branch:")) {
          const aiBranchId = nodeId.slice("ai_branch:".length);
          const updated = await upsertNodePosition({
            boardId,
            nodeRefType: "ai_branch",
            aiBranchId,
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
      } finally {
        persistingRef.current.delete(nodeId);
      }
    },
    [boardId, mode, getNodes, setFrames, setPositions, persistingRef],
  );

  const persistFrameResizeImpl = useCallback(
    async (nodeId: string, width: number, height: number) => {
      if (!nodeId.startsWith("frame:")) return;
      const frameId = nodeId.slice("frame:".length);
      // Skip the IPC/setFrames write when dimensions already match what's
      // rendered. React Flow emits `dim` changes whenever it reasserts a
      // node's size (e.g. after a rebuild that dropped `measured`), not
      // only on real resize — without this guard we'd write the same values
      // on every rebuild, flipping `frames` reference and triggering an
      // infinite rebuild loop.
      const rfNode = getNodes().find((n) => n.id === nodeId);
      const currentW = rfNode?.style?.width as number | undefined;
      const currentH = rfNode?.style?.height as number | undefined;
      if (currentW === width && currentH === height) return;
      try {
        await updateFrame(frameId, { width, height });
        setFrames((prev) =>
          prev.map((f) => (f.id === frameId ? { ...f, width, height } : f)),
        );
      } catch (err) {
        reportPersistError(err);
      }
    },
    [getNodes, setFrames],
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
