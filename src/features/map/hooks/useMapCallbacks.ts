import { useCallback, useMemo } from "react";
import { useDebouncedCallback } from "@/lib/useDebounce";
import type { Node, Edge, Connection } from "@xyflow/react";
import { useCodexStore } from "@/features/codex/codexStore";
import { upsertNodePosition, createUserEdge } from "../mapApi";
import { buildUpsertArgs } from "../utils/nodeIdCodec";
import type { MapAiNode, MapEdge } from "@/db/schema";

interface UseMapCallbacksInput {
  boardId: string | null;
  nodes: Node[];
  edges: Edge[];
  focusedNodeId: string | null;
  setUserEdges: React.Dispatch<React.SetStateAction<MapEdge[]>>;
  setAiNodes: React.Dispatch<React.SetStateAction<MapAiNode[]>>;
  setShowAINodeDialog: (v: boolean) => void;
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
  focusedNodeId,
  setUserEdges,
  setAiNodes,
  setShowAINodeDialog,
  setActiveScene,
  setSearchVisible,
  getViewport,
  setViewport,
  fitView,
}: UseMapCallbacksInput) {
  const onConnect = useCallback(
    async (connection: Connection) => {
      if (!boardId || !connection.source || !connection.target) return;
      const sourceArgs = buildUpsertArgs(boardId, connection.source);
      const targetArgs = buildUpsertArgs(boardId, connection.target);
      if (!sourceArgs || !targetArgs) return;
      const [sourcePos, targetPos] = await Promise.all([
        upsertNodePosition(sourceArgs),
        upsertNodePosition(targetArgs),
      ]);
      const newEdge = await createUserEdge({
        boardId,
        fromPositionId: sourcePos.id,
        toPositionId: targetPos.id,
      });
      setUserEdges((prev) => [...prev, newEdge]);
    },
    [boardId, setUserEdges],
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
      } else if (n.type === "ai") {
        const d = n.data as { prompt?: string };
        if (d.prompt) lines.push(`AI: ${d.prompt.slice(0, 50)}`);
      }
    }
    return lines;
  }, [nodes]);

  const handleAINodeCreated = useCallback(
    (created: {
      id: string;
      prompt: string;
      response: string;
      sessionId: string | null;
      position: { x: number; y: number };
    }) => {
      setShowAINodeDialog(false);
      const newAiNode: MapAiNode = {
        id: created.id,
        boardId: boardId!,
        prompt: created.prompt,
        response: created.response,
        sessionId: created.sessionId,
        model: null,
        tokenUsage: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setAiNodes((prev) => [...prev, newAiNode]);
    },
    [boardId, setAiNodes, setShowAINodeDialog],
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
    const connected = new Set<string>([focusedNodeId]);
    for (const edge of edges) {
      if (edge.source === focusedNodeId) connected.add(edge.target);
      if (edge.target === focusedNodeId) connected.add(edge.source);
    }
    return nodes.map((n) => ({
      ...n,
      style: { ...n.style, opacity: connected.has(n.id) ? 1 : 0.15 },
    }));
  }, [nodes, edges, focusedNodeId]);

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
