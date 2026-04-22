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
import { upsertNodePosition } from "./mapApi";
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

  const { getViewport, screenToFlowPosition, fitView, getNodes, getEdges } =
    useReactFlow();

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
  const [modeTransitionActive, setModeTransitionActive] = useState(false);
  const [forceLayoutRunning, setForceLayoutRunning] = useState(false);
  const [forceAlpha, setForceAlpha] = useState(1);

  // IDs of nodes currently being moved as part of a frame group drag.
  // Shared between useFrameGroupDrag (writer) and useMapNodes (reader) so
  // that any rebuild of nodes mid-drag does not revert contained nodes to
  // their pre-drag positions.
  const groupDraggingRef = useRef<Set<string>>(new Set());

  // Spawn counter: resets when viewport changes (pan/zoom)
  const spawnRef = useRef<{
    vp: { x: number; y: number; zoom: number };
    count: number;
  } | null>(null);

  // Trigger node transition when mode changes (skip on mount)
  const isMountRef = useRef(true);
  useEffect(() => {
    if (isMountRef.current) {
      isMountRef.current = false;
      return;
    }
    if (reducedMotion) return;
    setModeTransitionActive(true);
    const TRANSITION_MS = DURATIONS.slow * 1000 + 50; // 350ms
    const timer = setTimeout(
      () => setModeTransitionActive(false),
      TRANSITION_MS,
    );
    return () => clearTimeout(timer);
  }, [mode, reducedMotion]);

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
        connectionMode={
          paletteMode === "connect"
            ? ConnectionMode.Loose
            : ConnectionMode.Strict
        }
        nodesDraggable={paletteMode === "default" && !modeTransitionActive}
        elevateNodesOnSelect={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
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
