import { useCallback, useEffect, useRef } from "react";
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
  createUserEdge as createUserEdgeFn,
} from "../mapApi";
import type { MapNodePositionRecord } from "../types";
import type { MapEdge, MapFrame } from "@/db/schema";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import i18next from "@/lib/i18n";
import { useCurrentProjectId } from "@/features/project/projectStore";
import {
  flushMapPersistenceWritesInBackground,
  scheduleMapFrameResizeWrite,
} from "./mapPersistenceWriteQueue";

interface UseMapPositionPersistenceInput {
  boardId: string | null;
  mode: string;
  getNodes: () => Node[];
  setPositions: React.Dispatch<React.SetStateAction<MapNodePositionRecord[]>>;
  setPositionCoordinates: React.Dispatch<
    React.SetStateAction<MapNodePositionRecord[]>
  >;
  setFrames: React.Dispatch<React.SetStateAction<MapFrame[]>>;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setUserEdges: React.Dispatch<React.SetStateAction<MapEdge[]>>;
  /**
   * Synchronously-current snapshot of userEdges. Used by onEdgesChange so we
   * can read the to-be-deleted row without putting a side effect inside a
   * setUserEdges updater (StrictMode double-invokes setters).
   */
  userEdgesRef: React.MutableRefObject<MapEdge[]>;
  persistingRef: React.MutableRefObject<Set<string>>;
}

function reportPersistError(err: unknown) {
  // Unhandled IPC errors would otherwise surface as unhandledrejection and
  // leave the UI in an inconsistent state. Log + toast, swallow the rejection.

  console.error("[map] persistPosition failed", err);
  toast.error(i18next.t("map.toast.positionSaveFailed"), {
    description: String(err),
  });
}

export function useMapPositionPersistence({
  boardId,
  mode,
  getNodes,
  setPositions,
  setPositionCoordinates,
  setFrames,
  setNodes,
  setUserEdges,
  userEdgesRef,
  persistingRef,
}: UseMapPositionPersistenceInput) {
  const projectId = useCurrentProjectId();

  useEffect(
    () => () => {
      flushMapPersistenceWritesInBackground();
    },
    [projectId],
  );

  const publishPersistedPosition = useCallback(
    (updated: MapNodePositionRecord, invalidatesLayout = false) => {
      // Pure x/y/updatedAt writes keep the structural/layout revisions stable.
      // The invalidating publisher is reserved for an actual auto-pin.
      const publish = invalidatesLayout ? setPositions : setPositionCoordinates;
      publish((previous) => {
        const index = previous.findIndex(
          (position) => position.id === updated.id,
        );
        if (index < 0) return [...previous, updated];
        const next = [...previous];
        next[index] = updated;
        return next;
      });
    },
    [setPositionCoordinates, setPositions],
  );

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
    async (
      nodeId: string,
      x: number,
      y: number,
      startPos?: { x: number; y: number },
    ): Promise<void> => {
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
          const autoPinned = mode !== "free" && updated.pinned !== 1;
          if (autoPinned) {
            updated = (await setNodePinned(updated.id, true)) ?? updated;
          }
          publishPersistedPosition(
            updated as MapNodePositionRecord,
            autoPinned,
          );
        } else if (nodeId.startsWith("codex:")) {
          const codexEntryId = nodeId.slice("codex:".length);
          let updated = await upsertNodePosition({
            boardId,
            nodeRefType: "codex",
            codexEntryId,
            x,
            y,
          });
          const autoPinned = mode !== "free" && updated.pinned !== 1;
          if (autoPinned) {
            updated = (await setNodePinned(updated.id, true)) ?? updated;
          }
          publishPersistedPosition(
            updated as MapNodePositionRecord,
            autoPinned,
          );
        } else if (nodeId.startsWith("note:")) {
          const treeNodeId = nodeId.slice("note:".length);
          const updated = await upsertNodePosition({
            boardId,
            nodeRefType: "note",
            treeNodeId,
            x,
            y,
          });
          publishPersistedPosition(updated as MapNodePositionRecord);
        } else if (nodeId.startsWith("snippet:")) {
          const snippetId = nodeId.slice("snippet:".length);
          const updated = await upsertNodePosition({
            boardId,
            nodeRefType: "snippet",
            snippetId,
            x,
            y,
          });
          publishPersistedPosition(updated as MapNodePositionRecord);
        } else if (nodeId.startsWith("sticky:")) {
          const stickyId = nodeId.slice("sticky:".length);
          const updated = await upsertNodePosition({
            boardId,
            nodeRefType: "sticky",
            stickyId,
            x,
            y,
          });
          publishPersistedPosition(updated as MapNodePositionRecord);
        } else if (nodeId.startsWith("ai_branch:")) {
          const aiBranchId = nodeId.slice("ai_branch:".length);
          const updated = await upsertNodePosition({
            boardId,
            nodeRefType: "ai_branch",
            aiBranchId,
            x,
            y,
          });
          publishPersistedPosition(updated as MapNodePositionRecord);
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
        return;
      } finally {
        persistingRef.current.delete(nodeId);
      }

      if (
        startPos &&
        (startPos.x !== x || startPos.y !== y) &&
        !useGlobalHistoryStore.getState().isReplaying
      ) {
        const captured = {
          nodeId,
          fromX: startPos.x,
          fromY: startPos.y,
          toX: x,
          toY: y,
        };
        const moveTo = async (toX: number, toY: number) => {
          if (!boardId) return;
          if (captured.nodeId.startsWith("frame:")) {
            const frameId = captured.nodeId.slice("frame:".length);
            const frameNode = getNodes().find((n) => n.id === captured.nodeId);
            const w = (frameNode?.style?.width as number) ?? 400;
            const h = (frameNode?.style?.height as number) ?? 300;
            await updateFrame(frameId, { x: toX, y: toY, width: w, height: h });
            setFrames((prev) =>
              prev.map((f) =>
                f.id === frameId ? { ...f, x: toX, y: toY } : f,
              ),
            );
            return;
          }
          // For entity-backed nodes, rebuild the upsert args from the prefix.
          const [prefix, rawId] = captured.nodeId.split(":", 2);
          if (!prefix || !rawId) return;
          const args = (() => {
            switch (prefix) {
              case "scene":
                return {
                  boardId,
                  nodeRefType: "scene" as const,
                  treeNodeId: rawId,
                  x: toX,
                  y: toY,
                };
              case "codex":
                return {
                  boardId,
                  nodeRefType: "codex" as const,
                  codexEntryId: rawId,
                  x: toX,
                  y: toY,
                };
              case "note":
                return {
                  boardId,
                  nodeRefType: "note" as const,
                  treeNodeId: rawId,
                  x: toX,
                  y: toY,
                };
              case "snippet":
                return {
                  boardId,
                  nodeRefType: "snippet" as const,
                  snippetId: rawId,
                  x: toX,
                  y: toY,
                };
              case "sticky":
                return {
                  boardId,
                  nodeRefType: "sticky" as const,
                  stickyId: rawId,
                  x: toX,
                  y: toY,
                };
              case "ai_branch":
                return {
                  boardId,
                  nodeRefType: "ai_branch" as const,
                  aiBranchId: rawId,
                  x: toX,
                  y: toY,
                };
              default:
                return null;
            }
          })();
          if (!args) return;
          const updated = await upsertNodePosition(args);
          publishPersistedPosition(updated as MapNodePositionRecord);
        };
        useGlobalHistoryStore.getState().push({
          kind: "map",
          label: i18next.t("map.history.nodeMove"),
          async undo() {
            await moveTo(captured.fromX, captured.fromY);
          },
          async redo() {
            await moveTo(captured.toX, captured.toY);
          },
        });
      }
    },
    [
      boardId,
      mode,
      getNodes,
      setFrames,
      persistingRef,
      publishPersistedPosition,
    ],
  );

  const persistFrameResize = useCallback(
    (nodeId: string, width: number, height: number) => {
      if (!boardId || !nodeId.startsWith("frame:")) return;
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

      scheduleMapFrameResizeWrite({
        projectId,
        boardId,
        frameId,
        width,
        height,
        onPersist: () => {
          setFrames((prev) =>
            prev.map((f) => (f.id === frameId ? { ...f, width, height } : f)),
          );
        },
        onBackgroundError: reportPersistError,
      });
    },
    [boardId, getNodes, projectId, setFrames],
  );

  const dragStartPositionsRef = useRef(
    new Map<string, { x: number; y: number }>(),
  );

  const onNodesChange: OnNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Capture drag-start positions BEFORE applying the change so that the
      // history entry's "from" matches the position at drag start, not after
      // the first dragging:true event already nudged the node.
      setNodes((nds) => {
        for (const change of changes) {
          if (change.type === "position" && change.dragging) {
            if (!dragStartPositionsRef.current.has(change.id)) {
              const prevNode = nds.find((n) => n.id === change.id);
              if (prevNode) {
                dragStartPositionsRef.current.set(change.id, {
                  x: prevNode.position.x,
                  y: prevNode.position.y,
                });
              }
            }
          }
        }
        return applyNodeChanges(changes, nds);
      });
      for (const change of changes) {
        if (change.type === "position" && change.position && !change.dragging) {
          const startPos = dragStartPositionsRef.current.get(change.id);
          dragStartPositionsRef.current.delete(change.id);
          // persistPosition swallows its own errors, so no handler needed.
          void persistPosition(
            change.id,
            change.position.x,
            change.position.y,
            startPos,
          );
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
          // Read the to-be-deleted row from the synchronously-current ref
          // BEFORE mutating state. Putting a `find` inside a setUserEdges
          // updater would mis-capture under StrictMode's double-invoke.
          const captured = userEdgesRef.current.find((e) => e.id === dbId);
          if (!captured) continue;
          setUserEdges((prev) => prev.filter((e) => e.id !== dbId));
          const cap = captured;
          void (async () => {
            try {
              await deleteUserEdge(cap.id);
            } catch (err) {
              // IPC failed: roll the optimistic UI delete back and skip the
              // history push so undo cannot replay against a still-existing
              // DB row (UNIQUE violation).
              setUserEdges((prev) =>
                prev.some((e) => e.id === cap.id) ? prev : [...prev, cap],
              );
              reportPersistError(err);
              return;
            }
            if (useGlobalHistoryStore.getState().isReplaying) return;
            useGlobalHistoryStore.getState().push({
              kind: "map",
              label: i18next.t("map.history.edgeDelete"),
              async undo() {
                const recreated = await createUserEdgeFn({
                  id: cap.id,
                  boardId: cap.boardId,
                  fromPositionId: cap.fromPositionId,
                  toPositionId: cap.toPositionId,
                  forwardLabel: cap.forwardLabel ?? undefined,
                  backwardLabel: cap.backwardLabel ?? undefined,
                  style: cap.style,
                  color: cap.color,
                  direction: cap.direction,
                });
                setUserEdges((prev) => [...prev, recreated]);
              },
              async redo() {
                await deleteUserEdge(cap.id);
                setUserEdges((prev) => prev.filter((e) => e.id !== cap.id));
              },
            });
          })();
        }
      }
    },
    [setUserEdges, userEdgesRef],
  );

  return { onNodesChange, onEdgesChange, persistPosition };
}
