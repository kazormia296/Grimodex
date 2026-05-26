import { useState, useCallback } from "react";
import type { Node } from "@xyflow/react";
import { toast } from "sonner";
import {
  setNodePinned,
  updateNodePosition,
  upsertNodePosition,
  deleteNodePosition,
  promoteSticky,
  updateSticky,
  type PromoteTargetType,
} from "../mapApi";
import { findPosByNodeId, buildUpsertArgs } from "../utils/nodeIdCodec";
import type { MapNodePositionRecord } from "../types";
import type { MapSticky } from "@/db/schema";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useChatStore } from "@/features/chat/chatStore";
import * as chatApi from "@/features/chat/chatApi";

export interface ContextMenuState {
  nodeId: string;
  screenPosition: { x: number; y: number };
  isPinned: boolean;
  isScene: boolean;
  /** Sticky がアクティブセッションの L4 ピンに載っているか */
  isStickyPinnedToChat?: boolean;
}

interface UseMapContextMenuInput {
  boardId: string | null;
  projectId: string;
  positions: MapNodePositionRecord[];
  nodes: Node[];
  setPositions: React.Dispatch<React.SetStateAction<MapNodePositionRecord[]>>;
  setStickies: React.Dispatch<React.SetStateAction<MapSticky[]>>;
  setDeletingStickyIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setActiveScene: (id: string) => void;
  onAfterPromote?: (targetType: PromoteTargetType) => void;
}

export function useMapContextMenu({
  boardId,
  projectId,
  positions,
  nodes,
  setPositions,
  setStickies,
  setDeletingStickyIds,
  setActiveScene,
  onAfterPromote,
}: UseMapContextMenuInput) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      const pos = findPosByNodeId(positions, node.id);
      const baseMenu: ContextMenuState = {
        nodeId: node.id,
        screenPosition: { x: event.clientX, y: event.clientY },
        isPinned: pos ? pos.pinned === 1 : false,
        isScene: node.id.startsWith("scene:"),
      };
      setContextMenu(baseMenu);

      if (!node.id.startsWith("sticky:")) return;

      void (async () => {
        const sessionId = useChatStore.getState().activeSessionId;
        const stickyId = node.id.slice("sticky:".length);
        let isStickyPinnedToChat = false;
        if (sessionId) {
          const pinned = await chatApi.listPinnedStickyEntries(sessionId);
          isStickyPinnedToChat = pinned.some((s) => s.id === stickyId);
        }
        setContextMenu((prev) =>
          prev?.nodeId === node.id ? { ...prev, isStickyPinnedToChat } : prev,
        );
      })();
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

  /** For sticky nodes: trigger 2-phase animated delete. For others: remove from board only. */
  const handleRemoveFromBoard = useCallback(async () => {
    if (!contextMenu) return;
    const pos = findPosByNodeId(positions, contextMenu.nodeId);
    if (!pos) return;
    if (pos.stickyId) {
      // 2-phase delete: exit animation plays, actual DB delete happens in onStickyExitComplete
      setDeletingStickyIds((prev) => new Set(prev).add(pos.stickyId!));
    } else {
      const captured = { ...pos, nodeId: contextMenu.nodeId };
      try {
        await deleteNodePosition(pos.id);
      } catch (err) {
        toast.error("ボードからの削除に失敗しました", {
          description: String(err),
        });
        setContextMenu(null);
        return;
      }
      setPositions((prev) => prev.filter((p) => p.id !== pos.id));

      if (boardId && !useGlobalHistoryStore.getState().isReplaying) {
        const cap = captured;
        // upsertNodePosition は新規 row 作成時に新しい id を発行するため、
        // undo で復元された position の id を liveId に追跡し redo で削除対象を特定する
        let liveId = cap.id;
        useGlobalHistoryStore.getState().push({
          kind: "map",
          label: "ボードから外す",
          async undo() {
            const args = buildUpsertArgs(boardId, cap.nodeId, cap.x, cap.y);
            if (!args) return;
            const restored = await upsertNodePosition(args);
            liveId = restored.id;
            setPositions((prev) => [
              ...prev,
              restored as MapNodePositionRecord,
            ]);
          },
          async redo() {
            await deleteNodePosition(liveId);
            setPositions((prev) => prev.filter((p) => p.id !== liveId));
          },
        });
      }
    }
    setContextMenu(null);
  }, [contextMenu, positions, setPositions, setDeletingStickyIds, boardId]);

  const handleContextMenuOpen = useCallback(() => {
    if (!contextMenu) return;
    const sceneId = contextMenu.nodeId.slice("scene:".length);
    useTabStore.getState().openPinned(sceneId);
    useLayoutStore.getState().showPanel("editor");
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

  const handlePromoteSticky = useCallback(
    async (targetType: PromoteTargetType, codexType?: string) => {
      if (!contextMenu) return;
      const pos = findPosByNodeId(positions, contextMenu.nodeId);
      if (!pos?.stickyId) return;
      const { updatedPosition } = await promoteSticky(
        pos.stickyId,
        pos.id,
        targetType,
        { projectId, codexType },
      );
      setPositions((prev) =>
        prev.map((p) =>
          p.id === updatedPosition.id
            ? (updatedPosition as MapNodePositionRecord)
            : p,
        ),
      );
      setStickies((prev) => prev.filter((s) => s.id !== pos.stickyId));
      setContextMenu(null);
      onAfterPromote?.(targetType);
    },
    [
      contextMenu,
      positions,
      projectId,
      setPositions,
      setStickies,
      onAfterPromote,
    ],
  );

  const handleChangeStickyColor = useCallback(
    async (paletteId: string, colorSlot: number) => {
      if (!contextMenu) return;
      const pos = findPosByNodeId(positions, contextMenu.nodeId);
      if (!pos?.stickyId) return;
      await updateSticky(pos.stickyId, { paletteId, colorSlot });
      setStickies((prev) =>
        prev.map((s) =>
          s.id === pos.stickyId ? { ...s, paletteId, colorSlot } : s,
        ),
      );
      setContextMenu(null);
    },
    [contextMenu, positions, setStickies],
  );

  const handleToggleStickyChatPin = useCallback(async () => {
    if (!contextMenu) return;
    const pos = findPosByNodeId(positions, contextMenu.nodeId);
    if (!pos?.stickyId) return;
    const sessionId = useChatStore.getState().activeSessionId;
    if (!sessionId) {
      toast.error("アクティブなチャットセッションがありません");
      return;
    }
    if (contextMenu.isStickyPinnedToChat) {
      await chatApi.unpinStickyEntry(sessionId, pos.stickyId);
      toast.success("Sticky のチャットコンテキストピンを解除しました");
    } else {
      await chatApi.pinStickyEntry(sessionId, pos.stickyId);
      toast.success("Sticky をチャットコンテキストにピンしました");
    }
    await useChatStore.getState().refreshContextLayers();
    setContextMenu(null);
  }, [contextMenu, positions]);

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
    handlePromoteSticky,
    handleChangeStickyColor,
    handleToggleStickyChatPin,
  };
}
