import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  BackgroundVariant,
  useReactFlow,
  ConnectionMode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useMapStore } from "./mapStore";
import { SceneNode } from "./nodes/SceneNode";
import { CodexNode } from "./nodes/CodexNode";
import { FrameNode } from "./nodes/FrameNode";
import { NoteNode } from "./nodes/NoteNode";
import { StickyNode } from "./nodes/StickyNode";
import { SnippetNode } from "./nodes/SnippetNode";
import { AIBranchNode } from "./nodes/AIBranchNode";
import { NodeContextMenu } from "./NodeContextMenu";
import { UserEdge } from "./edges/UserEdge";
import { MapPalette } from "./MapPalette";
import { AddToMapPickerDialog } from "./AddToMapPickerDialog";
import { MapSearch } from "./MapSearch";
import { DURATIONS, useReducedMotion } from "@/lib/animation";
import { AutoArrangeDialog } from "./AutoArrangeDialog";
import { NodeDeleteDialog } from "./NodeDeleteDialog";
import {
  EdgeContextMenu,
  type EdgeContextMenuState,
} from "./edges/EdgeContextMenu";
import { ForceLayoutProgress } from "./ForceLayoutProgress";
import { useMapExport } from "./hooks/useMapExport";
import { useFrameDrawing } from "./hooks/useFrameDrawing";
import { useMapKeyboard } from "./hooks/useMapKeyboard";
import { useMapBoardData } from "./hooks/useMapBoardData";
import { useMapEdges } from "./hooks/useMapEdges";
import { useMapNodes } from "./hooks/useMapNodes";
import { useMapPositionPersistence } from "./hooks/useMapPositionPersistence";
import { useMapContextMenu } from "./hooks/useMapContextMenu";
import { useMapAutoArrange } from "./hooks/useMapAutoArrange";
import { useMapCallbacks } from "./hooks/useMapCallbacks";
import { useFrameGroupDrag } from "./hooks/useFrameGroupDrag";
import {
  deleteUserEdge,
  updateUserEdge,
  createUserEdge,
  deleteFrame,
  deleteAiBranch,
  deleteSticky,
  createSticky,
  createAiBranch,
  setNodePinned,
  deleteNodePosition,
  promoteFrame,
  listNodePositions,
  listStickies,
  pendingAutoFocusIds,
} from "./mapApi";
import { AINodeDialog } from "./AINodeDialog";
import { generateAiBranchCards } from "./mapAiApi";
import { deleteNode as deleteTreeNode } from "@/features/tree/api";
import { deleteCodexEntry } from "@/features/codex/api";
import { findPosByNodeId } from "./utils/nodeIdCodec";
import type { MapNodePositionRecord } from "./types";

const PROJECT_ID = "default-project";

/** Pure classification used by onDeleteSelected — exported for tests. */
export function partitionDeletableNodes(nodes: Node[]) {
  const frameNodes = nodes.filter(
    (n) => n.type === "frame" || n.id.startsWith("frame:"),
  );
  // Sticky and AI Branch nodes are deleted immediately (no confirm)
  const immediateNodes = nodes.filter(
    (n) => n.id.startsWith("sticky:") || n.id.startsWith("ai_branch:"),
  );
  // Scene/Codex/Note require confirmation dialog
  const entityNodes = nodes.filter(
    (n) =>
      n.id.startsWith("scene:") ||
      n.id.startsWith("note:") ||
      n.id.startsWith("codex:"),
  );
  // Snippets: remove from board only (no entity delete)
  const snippetNodes = nodes.filter((n) => n.id.startsWith("snippet:"));
  const showDialog = entityNodes.length > 0 ? entityNodes : [];
  return { frameNodes, showDialog, immediateNodes, snippetNodes };
}

const NODE_TYPES = {
  scene: SceneNode,
  codex: CodexNode,
  frame: FrameNode,
  note: NoteNode,
  sticky: StickyNode,
  snippet: SnippetNode,
  ai_branch: AIBranchNode,
};

const EDGE_TYPES = {
  user: UserEdge,
};

type PaletteMode = "default" | "frame" | "connect";

// Must be rendered inside ReactFlowProvider
export function MapCanvas() {
  const treeNodes = useTreeStore((s) => s.nodes);
  const codexEntries = useCodexStore((s) => s.entries);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);
  const updateNodeTitle = useTreeStore((s) => s.updateNodeTitle);
  const updateSynopsis = useTreeStore((s) => s.updateSynopsis);

  const phasesByEntry = usePhaseStore((s) => s.phasesByEntry);
  const snippetEntries = useSnippetStore((s) => s.entries);

  const mode = useMapStore((s) => s.mode);
  const setMode = useMapStore((s) => s.setMode);
  const show = useMapStore((s) => s.show);
  const minimapVisible = useMapStore((s) => s.minimapVisible);
  const gridSnap = useMapStore((s) => s.gridSnap);
  const setGridSnap = useMapStore((s) => s.setGridSnap);
  const setViewport = useMapStore((s) => s.setViewport);
  const colorBy = useMapStore((s) => s.colorBy);
  const visualTheme = useMapStore((s) => s.visualTheme);
  const searchVisible = useMapStore((s) => s.searchVisible);
  const setSearchVisible = useMapStore((s) => s.setSearchVisible);
  const pendingAutoArrange = useMapStore((s) => s.pendingAutoArrange);
  const setPendingAutoArrange = useMapStore((s) => s.setPendingAutoArrange);
  const focusedNodeId = useMapStore((s) => s.focusedNodeId);
  const setFocusedNode = useMapStore((s) => s.setFocusedNode);
  const pendingExport = useMapStore((s) => s.pendingExport);
  const setPendingExport = useMapStore((s) => s.setPendingExport);

  const {
    getViewport,
    screenToFlowPosition,
    fitView,
    getNodes,
    getEdges,
    zoomIn,
    zoomOut,
    zoomTo,
  } = useReactFlow();

  const reducedMotion = useReducedMotion();

  const {
    boardId,
    positions,
    setPositions,
    userEdges,
    setUserEdges,
    frames,
    setFrames,
    stickies,
    setStickies,
    aiBranches,
    setAiBranches,
  } = useMapBoardData(PROJECT_ID);

  const [nodes, setNodes] = useState<Node[]>([]);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("default");
  const [pickerType, setPickerType] = useState<
    "scene" | "note" | "codex" | "snippet" | null
  >(null);
  const [deleteDialogNodes, setDeleteDialogNodes] = useState<Node[] | null>(
    null,
  );
  const [edgeContextMenu, setEdgeContextMenu] =
    useState<EdgeContextMenuState | null>(null);
  const [aiBranchDialog, setAiBranchDialog] = useState<{
    spawnPosition: { x: number; y: number };
    seedNodeIds: string[];
    seedNodeTitles: string[];
  } | null>(null);
  const [generatingAiBranch, setGeneratingAiBranch] = useState(false);
  const [modeTransitionActive, setModeTransitionActive] = useState(false);
  const [forceLayoutRunning, setForceLayoutRunning] = useState(false);
  const [forceAlpha, setForceAlpha] = useState(1);
  const [deletingStickyIds, setDeletingStickyIds] = useState<Set<string>>(
    new Set(),
  );

  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  const groupDraggingRef = useRef<Set<string>>(new Set());
  const persistingRef = useRef<Set<string>>(new Set());

  const spawnRef = useRef<{
    vp: { x: number; y: number; zoom: number };
    count: number;
  } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const TRANSITION_MS = DURATIONS.slow * 1000 + 50;

  const isMountRef = useRef(true);
  useEffect(() => {
    if (isMountRef.current) {
      isMountRef.current = false;
      return;
    }
    if (reducedMotion || mode === "theme") return;
    setModeTransitionActive(true);
    const timer = setTimeout(
      () => setModeTransitionActive(false),
      TRANSITION_MS,
    );
    return () => clearTimeout(timer);
  }, [mode, reducedMotion, TRANSITION_MS]);

  const prevForceRunningRef = useRef(false);
  useEffect(() => {
    const prev = prevForceRunningRef.current;
    prevForceRunningRef.current = forceLayoutRunning;
    if (reducedMotion || mode !== "theme") return;
    if (prev && !forceLayoutRunning) {
      setModeTransitionActive(true);
      const timer = setTimeout(
        () => setModeTransitionActive(false),
        TRANSITION_MS,
      );
      return () => clearTimeout(timer);
    }
  }, [forceLayoutRunning, mode, reducedMotion, TRANSITION_MS]);

  const {
    frameDragStart,
    frameDragStartScreen,
    frameDraftRect,
    setFrameDraftRect,
    frameDraftScreenRect,
    setFrameDraftScreenRect,
    handleFrameOverlayDown,
    handleFrameOverlayMove,
    handleFrameOverlayUp,
  } = useFrameDrawing(screenToFlowPosition, boardId, setFrames, setPaletteMode);

  useEffect(() => {
    if (snippetEntries.length === 0) {
      void useSnippetStore.getState().loadEntries();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!show.derivedEdges || codexEntries.length === 0) return;
    const { loadPhasesForEntry, phasesByEntry: current } =
      usePhaseStore.getState();
    for (const entry of codexEntries) {
      if (!(entry.id in current)) {
        void loadPhasesForEntry(entry.id);
      }
    }
  }, [show.derivedEdges, codexEntries]);

  const onStickyExitComplete = useCallback(
    async (stickyId: string) => {
      // exitFiredRef in StickyNode guarantees this is called at most once per sticky.
      // Call deleteSticky outside the state updater to avoid React Strict Mode double-invoke.
      await deleteSticky(stickyId);
      setStickies((prev) => prev.filter((s) => s.id !== stickyId));
      setDeletingStickyIds((prev) => {
        const next = new Set(prev);
        next.delete(stickyId);
        return next;
      });
      const pos = findPosByNodeId(positionsRef.current, `sticky:${stickyId}`);
      if (pos) setPositions((prev) => prev.filter((p) => p.id !== pos.id));
    },
    [setStickies, setPositions],
  );

  useMapNodes({
    boardId,
    positions,
    treeNodes,
    codexEntries,
    snippets: snippetEntries,
    stickies,
    aiBranches,
    frames,
    show,
    mode,
    colorBy,
    visualTheme,
    modeTransitionActive,
    setFrames,
    setStickies,
    setAiBranches,
    setNodes,
    setForceLayoutRunning,
    setForceAlpha,
    updateNodeTitle,
    updateSynopsis,
    setActiveScene,
    groupDraggingRef,
    persistingRef,
    deletingStickyIds,
    onStickyExitComplete,
  });

  const handleUserEdgeLabelSave = useCallback(
    async (
      edgeId: string,
      field: "forwardLabel" | "backwardLabel",
      label: string | null,
    ) => {
      const updated = await updateUserEdge(edgeId, { [field]: label });
      if (updated) {
        setUserEdges((prev) =>
          prev.map((u) => (u.id === edgeId ? updated : u)),
        );
      }
    },
    [setUserEdges],
  );

  const edges = useMapEdges({
    codexEntries,
    treeNodes,
    snippetEntries,
    phasesByEntry,
    userEdges,
    positions,
    show,
    onUserEdgeLabelSave: handleUserEdgeLabelSave,
  });

  const { onNodesChange, onEdgesChange, persistPosition } =
    useMapPositionPersistence({
      boardId,
      mode,
      getNodes,
      setPositions,
      setFrames,
      setNodes,
      setUserEdges,
      persistingRef,
    });

  const {
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
  } = useMapContextMenu({
    boardId,
    projectId: PROJECT_ID,
    positions,
    nodes,
    setPositions,
    setStickies,
    setDeletingStickyIds,
    setActiveScene,
    onAfterPromote: (targetType) => {
      if (targetType === "scene" || targetType === "note") {
        void useTreeStore.getState().loadTree(PROJECT_ID);
      } else if (targetType === "codex") {
        void useCodexStore.getState().loadEntries();
      } else if (targetType === "snippet") {
        void useSnippetStore.getState().loadEntries();
      }
    },
  });

  const handlePromoteFrame = useCallback(
    async (codexType: string) => {
      if (!contextMenu || !boardId) return;
      const frameId = contextMenu.nodeId.slice("frame:".length);
      await promoteFrame(frameId, boardId, {
        projectId: PROJECT_ID,
        codexType,
      });
      setFrames((prev) => prev.filter((f) => f.id !== frameId));
      const [reloadedPos, reloadedStickies] = await Promise.all([
        listNodePositions(boardId),
        listStickies(boardId),
      ]);
      setPositions(reloadedPos as import("./types").MapNodePositionRecord[]);
      setStickies(reloadedStickies);
      void useCodexStore.getState().loadEntries();
      setContextMenu(null);
    },
    [
      contextMenu,
      boardId,
      setFrames,
      setPositions,
      setStickies,
      setContextMenu,
    ],
  );

  const {
    onConnect,
    onNodeDoubleClick,
    syncViewport,
    focusNode,
    visibleNodes,
    nodesWithFocus,
  } = useMapCallbacks({
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
  });

  const deleteEntityNodes = useCallback(
    async (nodesToDelete: Node[]) => {
      for (const node of nodesToDelete) {
        if (node.id.startsWith("scene:")) {
          await deleteTreeNode(node.id.slice("scene:".length));
        } else if (node.id.startsWith("note:")) {
          await deleteTreeNode(node.id.slice("note:".length));
        } else if (node.id.startsWith("codex:")) {
          await deleteCodexEntry(node.id.slice("codex:".length));
        } else if (node.id.startsWith("sticky:")) {
          // 2-phase delete: trigger exit animation first; actual DB delete
          // happens in onStickyExitComplete after the animation completes.
          const stickyId = node.id.slice("sticky:".length);
          setDeletingStickyIds((prev) => new Set(prev).add(stickyId));
        } else if (node.id.startsWith("ai_branch:")) {
          await deleteAiBranch(node.id.slice("ai_branch:".length));
        } else if (node.id.startsWith("snippet:")) {
          // Snippets: remove from board only
          const pos = findPosByNodeId(positionsRef.current, node.id);
          if (pos) await deleteNodePosition(pos.id);
        }
        // sticky position is cleaned up by onStickyExitComplete after animation
        if (!node.id.startsWith("sticky:")) {
          const pos = findPosByNodeId(positionsRef.current, node.id);
          if (pos) setPositions((prev) => prev.filter((p) => p.id !== pos.id));
        }
      }
    },
    [setPositions],
  );

  const onDeleteSelected = useCallback(async () => {
    if (!boardId) return;
    const selectedNodes = getNodes().filter((n) => n.selected);
    const selectedEdges = getEdges().filter((e) => e.selected);

    for (const edge of selectedEdges) {
      if (!edge.id.startsWith("user:")) continue;
      const userEdgeId = edge.id.slice("user:".length);
      await deleteUserEdge(userEdgeId);
      setUserEdges((prev) => prev.filter((u) => u.id !== userEdgeId));
    }

    const { frameNodes, showDialog, immediateNodes, snippetNodes } =
      partitionDeletableNodes(selectedNodes);

    for (const node of frameNodes) {
      const frameId = node.id.startsWith("frame:")
        ? node.id.slice("frame:".length)
        : node.id;
      await deleteFrame(frameId);
      setFrames((prev) => prev.filter((f) => f.id !== frameId));
    }

    for (const node of snippetNodes) {
      const pos = findPosByNodeId(positionsRef.current, node.id);
      if (pos) {
        await deleteNodePosition(pos.id);
        setPositions((prev) => prev.filter((p) => p.id !== pos.id));
      }
    }

    for (const node of immediateNodes) {
      await deleteEntityNodes([node]);
    }

    if (showDialog.length > 0) {
      setDeleteDialogNodes(showDialog);
    }
  }, [
    boardId,
    getNodes,
    getEdges,
    setUserEdges,
    setFrames,
    setPositions,
    deleteEntityNodes,
  ]);

  const selectAll = useCallback(() => {
    setNodes((prev) =>
      prev.map((n) => (n.type === "frame" ? n : { ...n, selected: true })),
    );
  }, [setNodes]);

  const onPinToggle = useCallback(async () => {
    if (!boardId) return;
    const selected = getNodes().filter((n) => n.selected && n.type !== "frame");
    await Promise.all(
      selected.map(async (n) => {
        const pos = findPosByNodeId(positionsRef.current, n.id);
        if (!pos) return;
        const isPinned = pos.pinned === 1;
        const updated = await setNodePinned(pos.id, !isPinned);
        if (updated) {
          setPositions((prev) =>
            prev.map((p) =>
              p.id === updated.id ? (updated as MapNodePositionRecord) : p,
            ),
          );
        }
      }),
    );
  }, [boardId, getNodes, setPositions]);

  const onEdgeContextMenu = useCallback(
    (e: React.MouseEvent, edge: { id: string; data?: unknown }) => {
      if (!edge.id.startsWith("user:")) return;
      e.preventDefault();
      const d = edge.data as {
        style?: "solid" | "dashed" | "dotted";
        color?: string;
      };
      setEdgeContextMenu({
        edgeId: edge.id.slice("user:".length),
        screenPosition: { x: e.clientX, y: e.clientY },
        style: d.style ?? "solid",
        color: d.color ?? "#555555",
      });
    },
    [],
  );

  const { onKeyDown, onKeyUp } = useMapKeyboard({
    searchVisible,
    setSearchVisible,
    focusedNodeId,
    setFocusedNode,
    gridSnap,
    setGridSnap,
    setMode,
    setPaletteMode,
    frameDraftRect,
    frameDragStart,
    frameDragStartScreen,
    setFrameDraftRect,
    setFrameDraftScreenRect,
    onDeleteSelected,
    onAddSticky: () => {
      void handleAddSticky();
    },
    fitView: () => fitView({ duration: 400 }),
    zoomIn: () => zoomIn({ duration: 200 }),
    zoomOut: () => zoomOut({ duration: 200 }),
    zoomReset: () => zoomTo(1, { duration: 200 }),
    selectAll,
    onPinToggle,
  });

  const { onNodeDragStart, onNodeDrag, onNodeDragStop } = useFrameGroupDrag({
    getNodes,
    setNodes,
    persistPosition,
    groupDraggingRef,
  });

  const getSpawnPosition = useCallback(() => {
    const vp = getViewport();
    const cur = spawnRef.current;
    if (
      !cur ||
      cur.vp.x !== vp.x ||
      cur.vp.y !== vp.y ||
      cur.vp.zoom !== vp.zoom
    ) {
      spawnRef.current = { vp: { x: vp.x, y: vp.y, zoom: vp.zoom }, count: 0 };
    }
    const idx = spawnRef.current!.count++;
    const rect = wrapperRef.current?.getBoundingClientRect();
    const screenCenter = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const center = screenToFlowPosition(screenCenter);
    return { x: center.x + idx * 24, y: center.y + idx * 24 };
  }, [getViewport, screenToFlowPosition]);

  const handleAddSticky = useCallback(
    async (flowPos?: { x: number; y: number }) => {
      if (!boardId) return;
      const pos = flowPos ?? getSpawnPosition();
      const sticky = await createSticky({
        boardId,
        x: pos.x,
        y: pos.y,
      });
      pendingAutoFocusIds.add(sticky.sticky.id);
      setStickies((prev) => [...prev, sticky.sticky]);
      setPositions((prev) => [
        ...prev,
        sticky.position as MapNodePositionRecord,
      ]);
    },
    [boardId, getSpawnPosition, setStickies, setPositions],
  );

  const handleBranchFromSticky = useCallback(async () => {
    if (!contextMenu || !boardId) return;
    const sourceNodeId = contextMenu.nodeId;
    const sourceNode = getNodes().find((n) => n.id === sourceNodeId);
    if (!sourceNode) return;
    const sourcePos = findPosByNodeId(positionsRef.current, sourceNodeId);
    if (!sourcePos) return;
    const sourceData = sourceNode.data as {
      paletteId?: string;
      colorSlot?: number;
    };
    const newX = sourceNode.position.x + 280;
    const newY = sourceNode.position.y;
    const result = await createSticky({
      boardId,
      x: newX,
      y: newY,
      paletteId: sourceData.paletteId,
      colorSlot: sourceData.colorSlot,
    });
    pendingAutoFocusIds.add(result.sticky.id);
    setStickies((prev) => [...prev, result.sticky]);
    setPositions((prev) => [...prev, result.position as MapNodePositionRecord]);
    const edge = await createUserEdge({
      boardId,
      fromPositionId: sourcePos.id,
      toPositionId: result.position.id,
    });
    setUserEdges((prev) => [...prev, edge]);
  }, [contextMenu, boardId, getNodes, setStickies, setPositions, setUserEdges]);

  const handlePaneDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if (!boardId) return;
      const flowPos = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      void handleAddSticky(flowPos);
    },
    [boardId, screenToFlowPosition, handleAddSticky],
  );

  const handleOpenAiBranch = useCallback(() => {
    if (!boardId) return;
    const selected = getNodes().filter((n) => n.selected && n.type !== "frame");
    const seedNodeIds = selected.map((n) => n.id);
    const seedNodeTitles = selected
      .map((n) => {
        const data = n.data as { title?: string; name?: string };
        return data.title ?? data.name ?? n.id;
      })
      .filter(Boolean) as string[];
    setAiBranchDialog({
      spawnPosition: getSpawnPosition(),
      seedNodeIds,
      seedNodeTitles,
    });
  }, [boardId, getNodes, getSpawnPosition]);

  const handleAiBranchConfirm = useCallback(
    async (prompt: string, count: 3 | 5 | 8) => {
      if (!boardId || !aiBranchDialog) return;
      const dialogState = aiBranchDialog;
      setAiBranchDialog(null);
      setGeneratingAiBranch(true);

      try {
        const cards = await generateAiBranchCards(
          prompt,
          count,
          dialogState.seedNodeTitles,
        );

        const pos = dialogState.spawnPosition;
        const result = await createAiBranch(
          boardId,
          prompt,
          dialogState.seedNodeIds,
          cards,
          { spawnX: pos.x, spawnY: pos.y },
        );

        setAiBranches((prev) => [...prev, result.branch]);
        setStickies((prev) => [...prev, ...result.stickies]);
        setPositions((prev) => [
          ...prev,
          ...(result.positions as MapNodePositionRecord[]),
        ]);
      } finally {
        setGeneratingAiBranch(false);
      }
    },
    [boardId, aiBranchDialog, setAiBranches, setStickies, setPositions],
  );

  const { executeAutoArrange } = useMapAutoArrange({
    boardId,
    pendingAutoArrange,
    positions,
    treeNodes,
    codexEntries,
    setPositions,
    setForceLayoutRunning,
    setForceAlpha,
    setPendingAutoArrange,
    setMode,
  });

  useMapExport(pendingExport, setPendingExport, getNodes, getEdges);

  const isCorkboard = visualTheme === "corkboard";

  return (
    <div
      ref={wrapperRef}
      className={isCorkboard ? "map-corkboard" : undefined}
      style={{ width: "100%", height: "100%", position: "relative" }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      tabIndex={0}
    >
      <ReactFlow
        nodes={nodesWithFocus}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneContextMenu={(e) => e.preventDefault()}
        zoomOnDoubleClick={false}
        onPaneClick={(e) => {
          if (e.detail === 2) handlePaneDoubleClick(e);
        }}
        onMoveEnd={syncViewport}
        snapToGrid={gridSnap}
        snapGrid={[16, 16]}
        fitView
        proOptions={{ hideAttribution: true }}
        connectionMode={ConnectionMode.Loose}
        nodesDraggable={paletteMode === "default" && !modeTransitionActive}
        className={paletteMode === "connect" ? "map-connect-mode" : undefined}
        elevateNodesOnSelect={false}
        deleteKeyCode={null}
      >
        {!isCorkboard && (
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        )}
        <Controls />
        {minimapVisible && (
          <MiniMap style={{ width: 120, height: 80 }} zoomable pannable />
        )}
      </ReactFlow>

      {paletteMode === "frame" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 10,
            cursor: "crosshair",
          }}
          onMouseDown={handleFrameOverlayDown}
          onMouseMove={handleFrameOverlayMove}
          onMouseUp={handleFrameOverlayUp}
        >
          {frameDraftScreenRect &&
            frameDraftScreenRect.w > 4 &&
            frameDraftScreenRect.h > 4 && (
              <div
                style={{
                  position: "absolute",
                  left: frameDraftScreenRect.x,
                  top: frameDraftScreenRect.y,
                  width: frameDraftScreenRect.w,
                  height: frameDraftScreenRect.h,
                  border: "2px dashed #534AB7",
                  background: "rgba(83,74,183,0.06)",
                  borderRadius: 4,
                  pointerEvents: "none",
                }}
              />
            )}
        </div>
      )}

      {searchVisible && (
        <MapSearch
          nodes={visibleNodes}
          onFocus={focusNode}
          onClose={() => setSearchVisible(false)}
        />
      )}

      {contextMenu && (
        <NodeContextMenu
          nodeId={contextMenu.nodeId}
          screenPosition={contextMenu.screenPosition}
          isPinned={contextMenu.isPinned}
          isScene={contextMenu.isScene}
          isSticky={contextMenu.nodeId.startsWith("sticky:")}
          isFrame={contextMenu.nodeId.startsWith("frame:")}
          focusedNodeId={focusedNodeId}
          onClose={() => setContextMenu(null)}
          onOpen={handleContextMenuOpen}
          onPin={handleContextMenuPin}
          onUnpin={handleContextMenuUnpin}
          onRemoveFromBoard={handleRemoveFromBoard}
          onFocus={() => setFocusedNode(contextMenu.nodeId)}
          onExitFocus={() => setFocusedNode(null)}
          onBringToFront={handleBringToFront}
          onSendToBack={handleSendToBack}
          onPromote={handlePromoteSticky}
          onPromoteFrame={handlePromoteFrame}
          onBranchFrom={
            contextMenu.nodeId.startsWith("sticky:")
              ? handleBranchFromSticky
              : undefined
          }
          onChangeColor={
            contextMenu.nodeId.startsWith("sticky:")
              ? handleChangeStickyColor
              : undefined
          }
          stickyPaletteId={
            contextMenu.nodeId.startsWith("sticky:")
              ? stickies.find((s) => `sticky:${s.id}` === contextMenu.nodeId)
                  ?.paletteId
              : undefined
          }
        />
      )}

      {pendingAutoArrange && (
        <AutoArrangeDialog
          type={pendingAutoArrange}
          onConfirm={executeAutoArrange}
          onCancel={() => setPendingAutoArrange(null)}
        />
      )}

      {forceLayoutRunning && <ForceLayoutProgress alpha={forceAlpha} />}

      {generatingAiBranch && (
        <div
          style={{
            position: "absolute",
            bottom: 60,
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--popover)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "6px 16px",
            fontSize: 12,
            color: "var(--foreground)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
            zIndex: 20,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span>✨ AI Branch を生成中…</span>
        </div>
      )}

      <MapPalette
        paletteMode={paletteMode}
        onPaletteModeChange={setPaletteMode}
        onAddSticky={() => {
          void handleAddSticky();
        }}
        onOpenPicker={setPickerType}
        onOpenAiBranch={handleOpenAiBranch}
      />

      {aiBranchDialog && boardId && (
        <AINodeDialog
          boardId={boardId}
          spawnPosition={aiBranchDialog.spawnPosition}
          seedNodeTitles={aiBranchDialog.seedNodeTitles}
          onConfirm={handleAiBranchConfirm}
          onCancel={() => setAiBranchDialog(null)}
        />
      )}

      {pickerType && boardId && (
        <AddToMapPickerDialog
          boardId={boardId}
          initialType={pickerType}
          onClose={() => setPickerType(null)}
        />
      )}

      {edgeContextMenu && (
        <EdgeContextMenu
          {...edgeContextMenu}
          onClose={() => setEdgeContextMenu(null)}
          onStyleChange={async (style) => {
            const updated = await updateUserEdge(edgeContextMenu.edgeId, {
              style,
            });
            if (updated)
              setUserEdges((prev) =>
                prev.map((u) =>
                  u.id === edgeContextMenu.edgeId ? updated : u,
                ),
              );
          }}
          onColorChange={async (color) => {
            const updated = await updateUserEdge(edgeContextMenu.edgeId, {
              color,
            });
            if (updated)
              setUserEdges((prev) =>
                prev.map((u) =>
                  u.id === edgeContextMenu.edgeId ? updated : u,
                ),
              );
          }}
          onDelete={async () => {
            await deleteUserEdge(edgeContextMenu.edgeId);
            setUserEdges((prev) =>
              prev.filter((u) => u.id !== edgeContextMenu.edgeId),
            );
          }}
        />
      )}

      {deleteDialogNodes && deleteDialogNodes.length > 0 && (
        <NodeDeleteDialog
          count={deleteDialogNodes.length}
          onDelete={async () => {
            await deleteEntityNodes(deleteDialogNodes);
            setDeleteDialogNodes(null);
          }}
          onCancel={() => setDeleteDialogNodes(null)}
        />
      )}
    </div>
  );
}
