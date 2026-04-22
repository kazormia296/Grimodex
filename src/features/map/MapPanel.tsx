import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedCallback } from "@/lib/useDebounce";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Connection,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
  ConnectionMode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useMapStore } from "./mapStore";
import {
  upsertNodePosition,
  createUserEdge,
  listAllNodePositions,
} from "./mapApi";
import { SceneNode } from "./nodes/SceneNode";
import { CodexNode } from "./nodes/CodexNode";
import { FrameNode } from "./nodes/FrameNode";
import { NoteNode } from "./nodes/NoteNode";
import { AINode } from "./nodes/AINode";
import { NodeContextMenu } from "./NodeContextMenu";
import { UserEdge } from "./edges/UserEdge";
import { MapHeader } from "./MapHeader";
import { MapPalette } from "./MapPalette";
import { MapSearch } from "./MapSearch";
import { AINodeDialog } from "./AINodeDialog";
import type { MapNodePositionRecord } from "./types";
import type { MapAiNode } from "@/db/schema";
import { WorkerForceLayoutEngine } from "./layouts/forceEngine";
import { autoArrange, autoArrangeForceDirected } from "./layouts/autoArrange";
import { DURATIONS, useReducedMotion } from "@/lib/animation";
import { AutoArrangeDialog } from "./AutoArrangeDialog";
import { ForceLayoutProgress } from "./ForceLayoutProgress";
import { buildUpsertArgs } from "./utils/nodeIdCodec";
import { useMapExport } from "./hooks/useMapExport";
import { useFrameDrawing } from "./hooks/useFrameDrawing";
import { useMapKeyboard } from "./hooks/useMapKeyboard";
import { useMapBoardData } from "./hooks/useMapBoardData";
import { useMapEdges } from "./hooks/useMapEdges";
import { useMapNodes } from "./hooks/useMapNodes";
import { useMapPositionPersistence } from "./hooks/useMapPositionPersistence";
import { useMapContextMenu } from "./hooks/useMapContextMenu";

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

// Deterministic rotation from node id for corkboard feel (±0.5deg)
// ── Main canvas (must be inside ReactFlowProvider) ────────────────────────

function MapCanvasInner() {
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

  const { onNodesChange, onEdgesChange } = useMapPositionPersistence({
    boardId,
    mode,
    nodes,
    setPositions,
    setFrames,
    setNodes,
    setUserEdges,
  });

  // Handle new connection
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
    [boardId],
  );

  // Double-click to open node in its panel
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

  // AI node creation
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
    [boardId],
  );

  // Sync viewport to store (debounced)
  const syncViewport = useDebouncedCallback(() => {
    const vp = getViewport();
    setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom });
  }, 300);

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

  // Focus node for search
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

  // Focus mode: dim non-connected nodes to 0.15 opacity
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

  // Execute confirmed auto-arrange
  const executeAutoArrange = useCallback(async () => {
    if (!pendingAutoArrange || !boardId) return;
    const type = pendingAutoArrange;
    setPendingAutoArrange(null);

    const hiddenSceneIds = new Set(
      positions
        .filter((p) => p.hidden === 1 && p.treeNodeId)
        .map((p) => p.treeNodeId!),
    );
    const hiddenCodexIds = new Set(
      positions
        .filter((p) => p.hidden === 1 && p.codexEntryId)
        .map((p) => p.codexEntryId!),
    );
    const scenes = treeNodes.filter(
      (n) => n.nodeType === "scene" && !hiddenSceneIds.has(n.id),
    );
    const visibleCodex = codexEntries.filter((e) => !hiddenCodexIds.has(e.id));
    const pinnedIds = new Set(
      positions
        .filter((p) => p.pinned === 1 && p.treeNodeId)
        .map((p) => p.treeNodeId!),
    );

    let newPositions;
    if (type === "force-directed") {
      setForceLayoutRunning(true);
      setForceAlpha(1);
      const engine = new WorkerForceLayoutEngine();
      newPositions = await autoArrangeForceDirected(
        { scenes, codexEntries: visibleCodex, positions },
        engine,
        pinnedIds,
        (alpha) => setForceAlpha(alpha),
      );
      setForceLayoutRunning(false);
    } else {
      newPositions = autoArrange({
        type,
        allTreeNodes: treeNodes,
        scenes,
        positions,
        variant,
      });
    }

    await Promise.all(
      Array.from(newPositions.entries()).map(([key, pos]) => {
        if (key.startsWith("scene:")) {
          return upsertNodePosition({
            boardId,
            nodeRefType: "scene",
            treeNodeId: key.slice("scene:".length),
            x: pos.x,
            y: pos.y,
          });
        }
        return Promise.resolve(undefined);
      }),
    );

    const refreshed = await listAllNodePositions(boardId);
    setPositions(refreshed as MapNodePositionRecord[]);
    setMode("free");
  }, [
    pendingAutoArrange,
    boardId,
    treeNodes,
    codexEntries,
    positions,
    variant,
    setPendingAutoArrange,
    setMode,
  ]);

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

// ── Panel wrapper ──────────────────────────────────────────────────────────

export function MapPanel() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "var(--background)",
      }}
    >
      <MapHeader />
      <div style={{ flex: 1, minHeight: 0 }}>
        <ReactFlowProvider>
          <MapCanvasInner />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
