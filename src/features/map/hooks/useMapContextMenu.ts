import { useState, useCallback } from "react";
import type { Node } from "@xyflow/react";
import {
  setNodePinned,
  updateNodePosition,
  upsertNodePosition,
  deleteNodePosition,
} from "../mapApi";
import { findPosByNodeId, buildUpsertArgs } from "../utils/nodeIdCodec";
import type { MapNodePositionRecord } from "../types";

export interface ContextMenuState {
  nodeId: string;
  screenPosition: { x: number; y: number };
  isPinned: boolean;
  isScene: boolean;
}

interface UseMapContextMenuInput {
  boardId: string | null;
  positions: MapNodePositionRecord[];
  nodes: Node[];
  setPositions: React.Dispatch<React.SetStateAction<MapNodePositionRecord[]>>;
  setActiveScene: (id: string) => void;
}

export function useMapContextMenu({
  boardId,
  positions,
  nodes,
  setPositions,
  setActiveScene,
}: UseMapContextMenuInput) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      const pos = findPosByNodeId(positions, node.id);
      setContextMenu({
        nodeId: node.id,
        screenPosition: { x: event.clientX, y: event.clientY },
        isPinned: pos ? pos.pinned === 1 : false,
        isScene: node.id.startsWith("scene:"),
      });
    },
    [positions],
  );

  const handleContextMenuPin = useCallback(async () => {
    if (!contextMenu) return;
    const pos = findPosByNodeId(positions, contextMenu.nodeId);
    if (!pos) return;
    const updated = await setNodePinned(pos.id, true);
    if (updated) {
      setPositions((prev) =>
        prev.map((p) =>
          p.id === updated.id ? (updated as MapNodePositionRecord) : p,
        ),
      );
    }
  }, [contextMenu, positions, setPositions]);

  const handleContextMenuUnpin = useCallback(async () => {
    if (!contextMenu) return;
    const pos = findPosByNodeId(positions, contextMenu.nodeId);
    if (!pos) return;
    const updated = await setNodePinned(pos.id, false);
    if (updated) {
      setPositions((prev) =>
        prev.map((p) =>
          p.id === updated.id ? (updated as MapNodePositionRecord) : p,
        ),
      );
    }
  }, [contextMenu, positions, setPositions]);

  /** Remove node from this board (delete position row, keep the entity itself). */
  const handleRemoveFromBoard = useCallback(async () => {
    if (!contextMenu) return;
    const pos = findPosByNodeId(positions, contextMenu.nodeId);
    if (!pos) return;
    await deleteNodePosition(pos.id);
    setPositions((prev) => prev.filter((p) => p.id !== pos.id));
    setContextMenu(null);
  }, [contextMenu, positions, setPositions]);

  const handleContextMenuOpen = useCallback(() => {
    if (!contextMenu) return;
    const sceneId = contextMenu.nodeId.slice("scene:".length);
    setActiveScene(sceneId);
  }, [contextMenu, setActiveScene]);

  const ensurePositionForNodeId = useCallback(
    async (nodeId: string): Promise<MapNodePositionRecord | undefined> => {
      if (!boardId) return undefined;
      const existing = findPosByNodeId(positions, nodeId);
      if (existing) return existing;
      const rfNode = nodes.find((n) => n.id === nodeId);
      const { x, y } = rfNode?.position ?? { x: 0, y: 0 };
      const args = buildUpsertArgs(boardId, nodeId, x, y);
      if (!args) return undefined;
      const p = await upsertNodePosition(args);
      return p as MapNodePositionRecord;
    },
    [boardId, positions, nodes],
  );

  const handleBringToFront = useCallback(async () => {
    if (!contextMenu) return;
    const maxZ = positions.reduce((m, p) => Math.max(m, p.zIndex ?? 0), 0);
    const newZ = maxZ + 1;
    const pos = await ensurePositionForNodeId(contextMenu.nodeId);
    if (!pos) return;
    const updated = await updateNodePosition(pos.id, { zIndex: newZ });
    if (updated) {
      setPositions((prev) =>
        prev.map((p) =>
          p.id === updated.id ? (updated as MapNodePositionRecord) : p,
        ),
      );
    }
  }, [contextMenu, positions, ensurePositionForNodeId, setPositions]);

  const handleSendToBack = useCallback(async () => {
    if (!contextMenu) return;
    const minZ = positions.reduce((m, p) => Math.min(m, p.zIndex ?? 0), 0);
    const newZ = Math.max(0, minZ - 1);
    const pos = await ensurePositionForNodeId(contextMenu.nodeId);
    if (!pos) return;
    const updated = await updateNodePosition(pos.id, { zIndex: newZ });
    if (updated) {
      setPositions((prev) =>
        prev.map((p) =>
          p.id === updated.id ? (updated as MapNodePositionRecord) : p,
        ),
      );
    }
  }, [contextMenu, positions, ensurePositionForNodeId, setPositions]);

  return {
    contextMenu,
    setContextMenu,
    onNodeContextMenu,
    handleContextMenuPin,
    handleContextMenuUnpin,
    handleRemoveFromBoard,
    handleContextMenuOpen,
    handleBringToFront,
    handleSendToBack,
  };
}
