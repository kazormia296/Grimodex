import { useCallback, useMemo } from "react";
import i18next from "@/lib/i18n";
import { useDebouncedCallback } from "@/lib/useDebounce";
import type { Node, Edge, Connection } from "@xyflow/react";
import { useCodexStore } from "@/features/codex/codexStore";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/application/editor/defaultEditorNavigation";
import { createUserEdge, deleteUserEdge } from "../mapApi";
import { useSettingsStore } from "@/features/settings/settingsStore";
import type { NewMapEdge } from "@/db/schema";

function defaultEdgeStyle(): NewMapEdge["style"] {
  const raw = useSettingsStore.getState().get("map.defaultEdgeStyle", "solid");
  return raw === "dashed" || raw === "dotted" ? raw : "solid";
}
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
  /** @deprecated Navigation is coordinated by openEditorDocument. */
  setActiveScene?: (id: string) => void;
  setUserEdges: React.Dispatch<React.SetStateAction<MapEdge[]>>;
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
        style: defaultEdgeStyle(),
      });
      setUserEdges((prev) => [...prev, newEdge]);

      if (!useGlobalHistoryStore.getState().isReplaying) {
        const captured = { ...newEdge };
        useGlobalHistoryStore.getState().push({
          kind: "map",
          label: i18next.t("map.history.edgeCreate"),
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
        const id = node.id.slice("scene:".length);
        openEditorDocument(
          {
            target: { kind: "scene", documentId: id },
            mode: "pinned",
            revealEditor: true,
            focusEditor: false,
            syncSceneContext: true,
          },
          defaultEditorNavigationPorts,
        );
      } else if (node.id.startsWith("note:")) {
        const id = node.id.slice("note:".length);
        openEditorDocument(
          {
            target: { kind: "scene", documentId: id },
            mode: "pinned",
            revealEditor: true,
            focusEditor: false,
            syncSceneContext: true,
          },
          defaultEditorNavigationPorts,
        );
      } else if (node.id.startsWith("codex:")) {
        useCodexStore
          .getState()
          .requestSelectEntry(node.id.slice("codex:".length));
      }
    },
    [],
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
