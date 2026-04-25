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
import { AINode } from "./nodes/AINode";
import { NodeContextMenu } from "./NodeContextMenu";
import { UserEdge } from "./edges/UserEdge";
import { MapPalette } from "./MapPalette";
import { MapSearch } from "./MapSearch";
import { AINodeDialog } from "./AINodeDialog";
import { DURATIONS, useReducedMotion } from "@/lib/animation";
import { AutoArrangeDialog } from "./AutoArrangeDialog";
import { NodeDeleteDialog } from "./NodeDeleteDialog";
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
  upsertNodePosition,
  updateNodePosition,
  deleteUserEdge,
  deleteFrame,
  deleteAINode,
  setNodePinned,
} from "./mapApi";
import { deleteNode as deleteTreeNode } from "@/features/tree/api";
import { deleteCodexEntry } from "@/features/codex/api";
import { findPosByNodeId, buildUpsertArgs } from "./utils/nodeIdCodec";
import type { MapNodePositionRecord } from "./types";

const PROJECT_ID = "default-project";

const NODE_TYPES = {
  scene: SceneNode,
  codex: CodexNode,
  frame: FrameNode,
  note: NoteNode,
  ai: AINode,
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
  const createScene = useTreeStore((s) => s.createScene);
  const createNote = useTreeStore((s) => s.createNote);
  const createCodexEntry = useCodexStore((s) => s.create);

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
  const corkboardFeel = useMapStore((s) => s.corkboardFeel);
  const effectiveSceneVariant = useMapStore((s) => s.effectiveSceneVariant);
  const searchVisible = useMapStore((s) => s.searchVisible);
  const setSearchVisible = useMapStore((s) => s.setSearchVisible);
  const pendingAutoArrange = useMapStore((s) => s.pendingAutoArrange);
  const setPendingAutoArrange = useMapStore((s) => s.setPendingAutoArrange);
  const focusedNodeId = useMapStore((s) => s.focusedNodeId);
  const setFocusedNode = useMapStore((s) => s.setFocusedNode);
  const pendingExport = useMapStore((s) => s.pendingExport);
  const setPendingExport = useMapStore((s) => s.setPendingExport);

  const variant = effectiveSceneVariant(mode);

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
    aiNodes,
    setAiNodes,
  } = useMapBoardData(PROJECT_ID);

  const [nodes, setNodes] = useState<Node[]>([]);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("default");
  const [showAINodeDialog, setShowAINodeDialog] = useState(false);
  const [deleteDialogNodes, setDeleteDialogNodes] = useState<Node[] | null>(
    null,
  );
  const [modeTransitionActive, setModeTransitionActive] = useState(false);
  const [forceLayoutRunning, setForceLayoutRunning] = useState(false);
  const [forceAlpha, setForceAlpha] = useState(1);

  // IDs of nodes currently being moved as part of a frame group drag.
  // Shared between useFrameGroupDrag (writer) and useMapNodes (reader) so
  // that any rebuild of nodes mid-drag does not revert contained nodes to
  // their pre-drag positions.
  const groupDraggingRef = useRef<Set<string>>(new Set());

  // IDs whose post-drop positions are being persisted to the DB (IPC in
  // flight). Between drop and setPositions/setFrames committing the new
  // coords, any unrelated dep change (concurrent drag, store write) can
  // trigger useMapNodes to rebuild from stale positions/frames — causing a
  // brief snap-back or all-nodes flicker. Preserving `prev.position` while
  // the id is in this set keeps the node visually stable during the window.
  const persistingRef = useRef<Set<string>>(new Set());

  // Spawn counter: resets when viewport changes (pan/zoom)
  const spawnRef = useRef<{
    vp: { x: number; y: number; zoom: number };
    count: number;
  } | null>(null);

  // Trigger node transition when mode changes (skip on mount)
  const TRANSITION_MS = DURATIONS.slow * 1000 + 50; // 350ms

  // Non-theme modes: start transition immediately on mode change.
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

  // Theme mode: start transition only after force layout finishes.
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

  // Load snippets for snippet-origin edges if not yet loaded
  useEffect(() => {
    if (snippetEntries.length === 0) {
      void useSnippetStore.getState().loadEntries();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-load phases for all codex entries so phase-anchor edges can render
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

  useMapNodes({
    boardId,
    positions,
    treeNodes,
    codexEntries,
    aiNodes,
    frames,
    show,
    mode,
    variant,
    colorBy,
    corkboardFeel,
    modeTransitionActive,
    setFrames,
    setNodes,
    setForceLayoutRunning,
    setForceAlpha,
    updateNodeTitle,
    updateSynopsis,
    setActiveScene,
    groupDraggingRef,
    persistingRef,
  });

  const edges = useMapEdges({
    codexEntries,
    treeNodes,
    snippetEntries,
    phasesByEntry,
    userEdges,
    positions,
    show,
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
    handleContextMenuHide,
    handleContextMenuShowHidden,
    handleContextMenuOpen,
    handleBringToFront,
    handleSendToBack,
  } = useMapContextMenu({
    boardId,
    positions,
    nodes,
    setPositions,
    setActiveScene,
  });

  const {
    onConnect,
    onNodeDoubleClick,
    aiContextLines,
    handleAINodeCreated,
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
    setAiNodes,
    setShowAINodeDialog,
    setActiveScene,
    setSearchVisible,
    getViewport,
    setViewport,
    fitView,
  });

  const hideNodes = useCallback(
    async (nodesToHide: Node[]) => {
      if (!boardId) return;
      for (const node of nodesToHide) {
        const existing = findPosByNodeId(positions, node.id);
        if (existing) {
          await updateNodePosition(existing.id, { hidden: 1 });
          setPositions((prev) =>
            prev.map((p) => (p.id === existing.id ? { ...p, hidden: 1 } : p)),
          );
        } else {
          const args = buildUpsertArgs(boardId, node.id);
          if (!args) continue;
          const newPos = await upsertNodePosition(args);
          await updateNodePosition(newPos.id, { hidden: 1 });
          setPositions((prev) => [
            ...prev,
            { ...newPos, hidden: 1 } as MapNodePositionRecord,
          ]);
        }
      }
    },
    [boardId, positions, setPositions],
  );

  const deleteEntityNodes = useCallback(
    async (nodesToDelete: Node[]) => {
      for (const node of nodesToDelete) {
        if (node.id.startsWith("scene:")) {
          await deleteTreeNode(node.id.slice("scene:".length));
        } else if (node.id.startsWith("note:")) {
          await deleteTreeNode(node.id.slice("note:".length));
        } else if (node.id.startsWith("codex:")) {
          await deleteCodexEntry(node.id.slice("codex:".length));
        } else if (node.id.startsWith("ai:")) {
          const aiId = node.id.slice("ai:".length);
          await deleteAINode(aiId);
          setAiNodes((prev) => prev.filter((a) => a.id !== aiId));
        }
        const pos = findPosByNodeId(positions, node.id);
        if (pos) {
          setPositions((prev) => prev.filter((p) => p.id !== pos.id));
        }
      }
    },
    [positions, setPositions, setAiNodes],
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

    // Frames and AI nodes: immediate delete (no dialog)
    const immediateNodes = selectedNodes.filter(
      (n) =>
        n.type === "frame" ||
        n.id.startsWith("frame:") ||
        n.id.startsWith("ai:"),
    );
    for (const node of immediateNodes) {
      if (node.id.startsWith("frame:") || node.type === "frame") {
        const frameId = node.id.startsWith("frame:")
          ? node.id.slice("frame:".length)
          : node.id;
        await deleteFrame(frameId);
        setFrames((prev) => prev.filter((f) => f.id !== frameId));
      } else if (node.id.startsWith("ai:")) {
        await deleteEntityNodes([node]);
      }
    }

    // Scene/Note/Codex: show dialog
    const dialogNodes = selectedNodes.filter(
      (n) =>
        n.id.startsWith("scene:") ||
        n.id.startsWith("note:") ||
        n.id.startsWith("codex:"),
    );
    if (dialogNodes.length > 0) {
      setDeleteDialogNodes(dialogNodes);
    }
  }, [boardId, getNodes, getEdges, setUserEdges, setFrames, deleteEntityNodes]);

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
        const pos = findPosByNodeId(positions, n.id);
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
  }, [boardId, getNodes, positions, setPositions]);

  const { onKeyDown } = useMapKeyboard({
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

  // Returns viewport-center position offset by spawn index (resets on pan/zoom)
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
    const cx = (-vp.x + window.innerWidth / 2) / vp.zoom;
    const cy = (-vp.y + window.innerHeight / 2) / vp.zoom;
    return { x: cx + idx * 24, y: cy + idx * 24 };
  }, [getViewport]);

  const handleAddScene = useCallback(async () => {
    if (!boardId) return;
    const pos = getSpawnPosition();
    const id = await createScene();
    const record = await upsertNodePosition({
      boardId,
      nodeRefType: "scene",
      treeNodeId: id,
      x: pos.x,
      y: pos.y,
    });
    setPositions((prev) => [...prev, record as MapNodePositionRecord]);
  }, [boardId, createScene, getSpawnPosition, setPositions]);

  const handleAddCodex = useCallback(async () => {
    if (!boardId) return;
    const pos = getSpawnPosition();
    const entry = await createCodexEntry({
      name: "新しいエントリ",
      type: "character",
      summary: "",
    });
    const record = await upsertNodePosition({
      boardId,
      nodeRefType: "codex",
      codexEntryId: entry.id,
      x: pos.x,
      y: pos.y,
    });
    setPositions((prev) => [...prev, record as MapNodePositionRecord]);
  }, [boardId, createCodexEntry, getSpawnPosition, setPositions]);

  const handleAddNote = useCallback(async () => {
    if (!boardId) return;
    const pos = getSpawnPosition();
    const id = await createNote();
    const record = await upsertNodePosition({
      boardId,
      nodeRefType: "note",
      treeNodeId: id,
      x: pos.x,
      y: pos.y,
    });
    setPositions((prev) => [...prev, record as MapNodePositionRecord]);
  }, [boardId, createNote, getSpawnPosition, setPositions]);

  const { executeAutoArrange } = useMapAutoArrange({
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
  });

  useMapExport(pendingExport, setPendingExport, getNodes, getEdges);

  return (
    <div
      className={corkboardFeel ? "map-corkboard" : undefined}
      style={{ width: "100%", height: "100%", position: "relative" }}
      onKeyDown={onKeyDown}
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
        onPaneContextMenu={(e) => e.preventDefault()}
        onMoveEnd={syncViewport}
        snapToGrid={gridSnap}
        snapGrid={[16, 16]}
        fitView
        proOptions={{ hideAttribution: true }}
        connectionMode={ConnectionMode.Loose}
        nodesDraggable={paletteMode === "default" && !modeTransitionActive}
        className={paletteMode === "connect" ? "map-connect-mode" : undefined}
        elevateNodesOnSelect={false}
      >
        <Background
          variant={
            corkboardFeel ? BackgroundVariant.Lines : BackgroundVariant.Dots
          }
          gap={corkboardFeel ? 40 : 24}
          size={1}
          color={corkboardFeel ? "rgba(139,92,44,0.12)" : undefined}
        />
        <Controls />
        {minimapVisible && (
          <MiniMap style={{ width: 120, height: 80 }} zoomable pannable />
        )}
      </ReactFlow>

      {/* Frame drawing overlay — captures all pointer events when active */}
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

      {/* Search overlay */}
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
          isHidden={contextMenu.isHidden}
          focusedNodeId={focusedNodeId}
          onClose={() => setContextMenu(null)}
          onOpen={handleContextMenuOpen}
          onPin={handleContextMenuPin}
          onUnpin={handleContextMenuUnpin}
          onHide={handleContextMenuHide}
          onShowHidden={handleContextMenuShowHidden}
          onFocus={() => setFocusedNode(contextMenu.nodeId)}
          onExitFocus={() => setFocusedNode(null)}
          onBringToFront={handleBringToFront}
          onSendToBack={handleSendToBack}
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

      <MapPalette
        paletteMode={paletteMode}
        onPaletteModeChange={setPaletteMode}
        onCreateAI={() => setShowAINodeDialog(true)}
        onAddScene={handleAddScene}
        onAddCodex={handleAddCodex}
        onAddNote={handleAddNote}
      />

      {deleteDialogNodes && deleteDialogNodes.length > 0 && (
        <NodeDeleteDialog
          count={deleteDialogNodes.length}
          onHide={async () => {
            await hideNodes(deleteDialogNodes);
            setDeleteDialogNodes(null);
          }}
          onDelete={async () => {
            await deleteEntityNodes(deleteDialogNodes);
            setDeleteDialogNodes(null);
          }}
          onCancel={() => setDeleteDialogNodes(null)}
        />
      )}

      {showAINodeDialog && boardId && (
        <AINodeDialog
          boardId={boardId}
          contextLines={aiContextLines()}
          spawnPosition={(() => {
            const vp = getViewport();
            return {
              x: (-vp.x + window.innerWidth / 2) / vp.zoom,
              y: (-vp.y + window.innerHeight / 2) / vp.zoom,
            };
          })()}
          onCreated={handleAINodeCreated}
          onCancel={() => setShowAINodeDialog(false)}
        />
      )}
    </div>
  );
}
