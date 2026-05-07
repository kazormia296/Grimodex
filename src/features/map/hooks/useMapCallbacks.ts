import { useCallback, useMemo } from "react";
import { useDebouncedCallback } from "@/lib/useDebounce";
import type { Node, Edge, Connection } from "@xyflow/react";
import { useCodexStore } from "@/features/codex/codexStore";
import { createUserEdge, deleteUserEdge } from "../mapApi";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { findPosByNodeId } from "../utils/nodeIdCodec";
import type { MapEdge } from "@/db/schema";
import type { MapNodePositionRecord } from "../types";
import { buildFocusNeighbors } from "./focusNeighbors";

interface UseMapCallbacksInput {
  boardId: string | null;
  nodes: Node[];
  edges: Edge[];
  userEdges: MapEdge[];
  positions: MapNodePositionRecord[];
  focusedNodeId: string | null;
  setUserEdges: React.Dispatch<React.SetStateAction<MapEdge[]>>;
  setActiveScene: (id: string) => void;
  setSearchVisible: (v: boolean) => void;
  getViewport: () => { x: number; y: number; zoom: number };
  setViewport: (vp: { x: number; y: number; zoom: number }) => void;
  fitView: (opts?: {
    nodes?: Node[];
    duration?: number;
    padding?: number;
  }) => void;
}

export function useMapCallbacks({
  boardId,
  nodes,
  edges,
  userEdges,
  positions,
  focusedNodeId,
  setUserEdges,
  setActiveScene,
  setSearchVisible,
  getViewport,
  setViewport,
  fitView,
}: UseMapCallbacksInput) {
  const onConnect = useCallback(
    async (connection: Connection) => {
      if (!boardId || !connection.source || !connection.target) return;
      const sourcePos = findPosByNodeId(positions, connection.source);
      const targetPos = findPosByNodeId(positions, connection.target);
      if (!sourcePos || !targetPos) return;
      const newEdge = await createUserEdge({
        boardId,
        fromPositionId: sourcePos.id,
        toPositionId: targetPos.id,
      });
      setUserEdges((prev) => [...prev, newEdge]);

      if (!useGlobalHistoryStore.getState().isReplaying) {
        const captured = { ...newEdge };
        useGlobalHistoryStore.getState().push({
          kind: "map",
          label: "エッジ作成",
          async undo() {
            await deleteUserEdge(captured.id);
            setUserEdges((prev) => prev.filter((e) => e.id !== captured.id));
          },
          async redo() {
            const recreated = await createUserEdge({
              id: captured.id,
              boardId: captured.boardId,
              fromPositionId: captured.fromPositionId,
              toPositionId: captured.toPositionId,
              forwardLabel: captured.forwardLabel ?? undefined,
              backwardLabel: captured.backwardLabel ?? undefined,
              style: captured.style,
              color: captured.color,
              direction: captured.direction,
            });
            setUserEdges((prev) => [...prev, recreated]);
          },
        });
      }
    },
    [boardId, positions, setUserEdges],
  );

  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.id.startsWith("scene:")) {
        setActiveScene(node.id.slice("scene:".length));
      } else if (node.id.startsWith("note:")) {
        setActiveScene(node.id.slice("note:".length));
      } else if (node.id.startsWith("codex:")) {
        useCodexStore
          .getState()
          .requestSelectEntry(node.id.slice("codex:".length));
      }
    },
    [setActiveScene],
  );

  const aiContextLines = useCallback((): string[] => {
    const lines: string[] = [];
    for (const n of nodes) {
      if (n.type === "scene") {
        const d = n.data as { title?: string };
        if (d.title) lines.push(`Scene: ${d.title}`);
      } else if (n.type === "codex") {
        const d = n.data as { name?: string; type?: string };
        if (d.name) lines.push(`${d.type ?? "Codex"}: ${d.name}`);
      } else if (n.type === "note") {
        const d = n.data as { title?: string };
        if (d.title) lines.push(`Note: ${d.title}`);
      } else if (n.type === "ai_branch") {
        const d = n.data as { prompt?: string };
        if (d.prompt) lines.push(`AI: ${d.prompt.slice(0, 50)}`);
      }
    }
    return lines;
  }, [nodes]);

  // Stub — AI Branch creation is Phase C
  const handleAINodeCreated = useCallback(
    (_created: unknown) => {
      void _created;
      void boardId;
    },
    [boardId],
  );

  const syncViewport = useDebouncedCallback(() => {
    const vp = getViewport();
    setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom });
  }, 300);

  const focusNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      fitView({ nodes: [node], duration: 400, padding: 0.5 });
      setSearchVisible(false);
    },
    [nodes, fitView, setSearchVisible],
  );

  const visibleNodes = useMemo(
    () => nodes.filter((n) => n.type !== "frame"),
    [nodes],
  );

  const nodesWithFocus = useMemo(() => {
    if (!focusedNodeId) return nodes;
    const connected = buildFocusNeighbors(
      focusedNodeId,
      edges,
      userEdges,
      positions,
    );
    return nodes.map((n) => ({
      ...n,
      style: { ...n.style, opacity: connected.has(n.id) ? 1 : 0.15 },
    }));
  }, [nodes, edges, userEdges, positions, focusedNodeId]);

  return {
    onConnect,
    onNodeDoubleClick,
    aiContextLines,
    handleAINodeCreated,
    syncViewport,
    focusNode,
    visibleNodes,
    nodesWithFocus,
  };
}
