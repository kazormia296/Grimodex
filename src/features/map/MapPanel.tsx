import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type NodeChange,
  type Connection,
  applyNodeChanges,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
  addEdge,
  ConnectionMode,
  type XYPosition,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useMapStore } from "./mapStore";
import {
  getOrCreateBoard,
  listAllNodePositions,
  upsertNodePosition,
  setNodePinned,
  updateNodePosition,
  listUserEdges,
  createUserEdge,
  deleteUserEdge,
  listFrames,
  createFrame,
  updateFrame,
  deleteFrame,
} from "./mapApi";
import { SceneNode } from "./nodes/SceneNode";
import { CodexNode } from "./nodes/CodexNode";
import { FrameNode } from "./nodes/FrameNode";
import { NodeContextMenu } from "./NodeContextMenu";
import { UserEdge } from "./edges/UserEdge";
import { MapHeader } from "./MapHeader";
import { MapPalette } from "./MapPalette";
import { MapSearch } from "./MapSearch";
import type { MapNodePositionRecord } from "./types";
import type { MapEdge, MapFrame } from "@/db/schema";
import { layoutFor } from "./layouts";
import { autoArrange } from "./layouts/autoArrange";
import { DURATIONS, useReducedMotion } from "@/lib/animation";
import { AutoArrangeDialog } from "./AutoArrangeDialog";

const PROJECT_ID = "default-project";

const NODE_TYPES = {
  scene: SceneNode,
  codex: CodexNode,
  frame: FrameNode,
};

const EDGE_TYPES = {
  user: UserEdge,
};

type PaletteMode = "default" | "frame" | "connect";

// Debounce helper
function useDebouncedCallback<T extends unknown[]>(
  fn: (...args: T) => void,
  delay: number,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(
    (...args: T) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fn(...args), delay);
    },
    [fn, delay],
  );
}

// Deterministic rotation from node id for corkboard feel (±0.5deg)
function corkRotation(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return ((hash % 100) / 100) * 1.0 - 0.5;
}

// ── Main canvas (must be inside ReactFlowProvider) ────────────────────────

function MapCanvasInner() {
  const treeNodes = useTreeStore((s) => s.nodes);
  const codexEntries = useCodexStore((s) => s.entries);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);
  const updateNodeTitle = useTreeStore((s) => s.updateNodeTitle);
  const updateSynopsis = useTreeStore((s) => s.updateSynopsis);

  const mode = useMapStore((s) => s.mode);
  const show = useMapStore((s) => s.show);
  const minimapVisible = useMapStore((s) => s.minimapVisible);
  const gridSnap = useMapStore((s) => s.gridSnap);
  const setViewport = useMapStore((s) => s.setViewport);
  const colorBy = useMapStore((s) => s.colorBy);
  const corkboardFeel = useMapStore((s) => s.corkboardFeel);
  const effectiveSceneVariant = useMapStore((s) => s.effectiveSceneVariant);
  const searchVisible = useMapStore((s) => s.searchVisible);
  const setSearchVisible = useMapStore((s) => s.setSearchVisible);
  const pendingAutoArrange = useMapStore((s) => s.pendingAutoArrange);
  const setPendingAutoArrange = useMapStore((s) => s.setPendingAutoArrange);

  const variant = effectiveSceneVariant(mode);

  const { getViewport, screenToFlowPosition, fitView } = useReactFlow();

  const reducedMotion = useReducedMotion();

  const [boardId, setBoardId] = useState<string | null>(null);
  const [positions, setPositions] = useState<MapNodePositionRecord[]>([]);
  const [userEdges, setUserEdges] = useState<MapEdge[]>([]);
  const [frames, setFrames] = useState<MapFrame[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("default");
  const [modeTransitionActive, setModeTransitionActive] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    nodeId: string;
    screenPosition: { x: number; y: number };
    isPinned: boolean;
    isScene: boolean;
  } | null>(null);
  // searchOpen は mapStore.searchVisible で管理（MapHeaderから開くため）

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

  // Frame drawing state
  const frameDragStart = useRef<XYPosition | null>(null);
  const [frameDraftRect, setFrameDraftRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  // Load board + positions + edges + frames on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const board = await getOrCreateBoard(PROJECT_ID);
      if (cancelled) return;
      setBoardId(board.id);
      const [pos, ue, fr] = await Promise.all([
        listAllNodePositions(board.id),
        listUserEdges(board.id),
        listFrames(board.id),
      ]);
      if (cancelled) return;
      setPositions(pos as MapNodePositionRecord[]);
      setUserEdges(ue);
      setFrames(fr);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Build React Flow nodes: frames + scene nodes + codex nodes
  useEffect(() => {
    if (!boardId) return;

    // Derive visible/hidden sets from positions (hidden=1 persists across sessions)
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
    const visiblePositions = positions.filter((p) => p.hidden !== 1);

    const scenes = treeNodes.filter(
      (n) => n.nodeType === "scene" && !hiddenSceneIds.has(n.id),
    );
    const visibleCodex = codexEntries.filter((e) => !hiddenCodexIds.has(e.id));
    const computedPositions = layoutFor(mode, {
      scenes,
      codexEntries: visibleCodex,
      positions: visiblePositions,
    });

    // Frame nodes rendered behind other nodes
    const frameNodes: Node[] = show.frames
      ? frames.map((f) => ({
          id: `frame:${f.id}`,
          type: "frame",
          position: { x: f.x, y: f.y },
          style: { width: f.width, height: f.height },
          zIndex: -1,
          dragHandle: ".frame-drag-handle",
          data: {
            title: f.title,
            background: f.background,
            borderColor: f.borderColor,
            onTitleChange: async (title: string) => {
              await updateFrame(f.id, { title });
              setFrames((prev) =>
                prev.map((fr) => (fr.id === f.id ? { ...fr, title } : fr)),
              );
            },
            onDelete: async () => {
              await deleteFrame(f.id);
              setFrames((prev) => prev.filter((fr) => fr.id !== f.id));
            },
          },
        }))
      : [];

    const transitionClass = modeTransitionActive
      ? "with-mode-transition"
      : undefined;

    // Scene nodes
    const sceneNodes: Node[] = show.scenes
      ? scenes.map((n) => {
          const key = `scene:${n.id}`;
          const pos = computedPositions.get(key) ?? { x: 0, y: 0 };
          const rotation = corkboardFeel ? corkRotation(n.id) : 0;
          return {
            id: key,
            type: "scene",
            position: pos,
            className: transitionClass,
            draggable: mode === "free",
            zIndex: 0,
            data: {
              title: n.title,
              synopsis: n.synopsis ?? null,
              status: n.status ?? "outline",
              wordCount: undefined,
              variant,
              colorBy,
              corkboardFeel,
              rotation,
              onTitleChange: async (title: string) => {
                await updateNodeTitle(n.id, title);
              },
              onSynopsisChange: async (synopsis: string) => {
                await updateSynopsis(n.id, synopsis);
              },
              onOpen: () => {
                setActiveScene(n.id);
              },
            },
          };
        })
      : [];

    const codexNodes: Node[] = show.codex
      ? visibleCodex.map((e) => {
          const key = `codex:${e.id}`;
          const pos = computedPositions.get(key) ?? { x: 0, y: 0 };
          return {
            id: key,
            type: "codex",
            position: pos,
            className: transitionClass,
            zIndex: 0,
            data: {
              name: e.name,
              type: e.type,
              summary: e.summary ?? "",
              color: "#534AB7",
            },
          };
        })
      : [];

    setNodes([...frameNodes, ...sceneNodes, ...codexNodes]);
  }, [
    boardId,
    positions,
    treeNodes,
    codexEntries,
    show,
    mode,
    variant,
    colorBy,
    corkboardFeel,
    frames,
    modeTransitionActive,
    updateNodeTitle,
    updateSynopsis,
    setActiveScene,
  ]);

  // Build edges: derived + user
  useEffect(() => {
    const derived: Edge[] = show.derivedEdges
      ? codexEntries
          .filter((e) => e.parentId != null)
          .map((e) => ({
            id: `derived:${e.id}->${e.parentId}`,
            source: `codex:${e.parentId}`,
            target: `codex:${e.id}`,
            style: { stroke: "#999", strokeDasharray: "4 2" },
            animated: false,
            zIndex: 0,
          }))
      : [];

    const user: Edge[] = show.userEdges
      ? userEdges
          .map((ue) => {
            const fromPos = positions.find((p) => p.id === ue.fromPositionId);
            const toPos = positions.find((p) => p.id === ue.toPositionId);
            const sourceId = fromPos?.treeNodeId
              ? `scene:${fromPos.treeNodeId}`
              : fromPos?.codexEntryId
                ? `codex:${fromPos.codexEntryId}`
                : null;
            const targetId = toPos?.treeNodeId
              ? `scene:${toPos.treeNodeId}`
              : toPos?.codexEntryId
                ? `codex:${toPos.codexEntryId}`
                : null;
            if (!sourceId || !targetId) return null;
            return {
              id: `user:${ue.id}`,
              source: sourceId,
              target: targetId,
              type: "user",
              zIndex: 1,
              data: {
                label: ue.label,
                style: ue.style,
                color: ue.color,
                direction: ue.direction,
              },
            } as Edge;
          })
          .filter((e): e is Edge => e !== null)
      : [];

    setEdges([...derived, ...user]);
  }, [codexEntries, userEdges, positions, show.derivedEdges, show.userEdges]);

  // Persist position changes (debounced)
  const persistPosition = useDebouncedCallback(
    async (nodeId: string, x: number, y: number) => {
      if (!boardId) return;
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
        if (mode !== "free" && updated.pinned !== 1) {
          updated = (await setNodePinned(updated.id, true)) ?? updated;
        }
        setPositions((prev) => {
          const idx = prev.findIndex((p) => p.id === updated.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = updated as MapNodePositionRecord;
            return next;
          }
          return [...prev, updated as MapNodePositionRecord];
        });
      } else if (nodeId.startsWith("codex:")) {
        const codexEntryId = nodeId.slice("codex:".length);
        let updated = await upsertNodePosition({
          boardId,
          nodeRefType: "codex",
          codexEntryId,
          x,
          y,
        });
        if (mode !== "free" && updated.pinned !== 1) {
          updated = (await setNodePinned(updated.id, true)) ?? updated;
        }
        setPositions((prev) => {
          const idx = prev.findIndex((p) => p.id === updated.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = updated as MapNodePositionRecord;
            return next;
          }
          return [...prev, updated as MapNodePositionRecord];
        });
      } else if (nodeId.startsWith("frame:")) {
        const frameId = nodeId.slice("frame:".length);
        const frameNode = nodes.find((n) => n.id === nodeId);
        const w = (frameNode?.style?.width as number) ?? 400;
        const h = (frameNode?.style?.height as number) ?? 300;
        await updateFrame(frameId, { x, y, width: w, height: h });
        setFrames((prev) =>
          prev.map((f) => (f.id === frameId ? { ...f, x, y } : f)),
        );
      }
    },
    500,
  );

  // Persist frame resize
  const persistFrameResize = useDebouncedCallback(
    async (nodeId: string, width: number, height: number) => {
      if (!nodeId.startsWith("frame:")) return;
      const frameId = nodeId.slice("frame:".length);
      await updateFrame(frameId, { width, height });
      setFrames((prev) =>
        prev.map((f) => (f.id === frameId ? { ...f, width, height } : f)),
      );
    },
    500,
  );

  const onNodesChange: OnNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
      for (const change of changes) {
        if (change.type === "position" && change.position && !change.dragging) {
          persistPosition(change.id, change.position.x, change.position.y);
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
    [persistPosition, persistFrameResize],
  );

  const onEdgesChange: OnEdgesChange = useCallback((changes) => {
    setEdges((eds) => {
      let result = [...eds];
      for (const change of changes) {
        if (change.type === "remove") {
          const edgeId = change.id;
          if (edgeId.startsWith("user:")) {
            const dbId = edgeId.slice("user:".length);
            deleteUserEdge(dbId).catch(() => {});
            setUserEdges((prev) => prev.filter((e) => e.id !== dbId));
          }
          result = result.filter((e) => e.id !== edgeId);
        }
      }
      return result;
    });
  }, []);

  // Handle new connection
  const onConnect = useCallback(
    async (connection: Connection) => {
      if (!boardId || !connection.source || !connection.target) return;

      const toPositionArgs = (rfId: string) =>
        rfId.startsWith("scene:")
          ? {
              boardId,
              nodeRefType: "scene" as const,
              treeNodeId: rfId.slice("scene:".length),
              x: 0,
              y: 0,
            }
          : {
              boardId,
              nodeRefType: "codex" as const,
              codexEntryId: rfId.slice("codex:".length),
              x: 0,
              y: 0,
            };

      const [sourcePos, targetPos] = await Promise.all([
        upsertNodePosition(toPositionArgs(connection.source)),
        upsertNodePosition(toPositionArgs(connection.target)),
      ]);

      const newEdge = await createUserEdge({
        boardId,
        fromPositionId: sourcePos.id,
        toPositionId: targetPos.id,
      });
      setUserEdges((prev) => [...prev, newEdge]);

      const rfEdge: Edge = {
        id: `user:${newEdge.id}`,
        source: connection.source,
        target: connection.target,
        type: "user",
        zIndex: 1,
        data: { label: null, style: "solid", color: "#555", direction: "none" },
      };
      setEdges((eds) => addEdge(rfEdge, eds));
    },
    [boardId],
  );

  // Double-click to open scene in editor
  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.id.startsWith("scene:")) {
        const sceneId = node.id.slice("scene:".length);
        setActiveScene(sceneId);
      }
    },
    [setActiveScene],
  );

  // Node context menu handler
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      const pos = positions.find(
        (p) =>
          (node.id.startsWith("scene:") &&
            p.treeNodeId === node.id.slice("scene:".length)) ||
          (node.id.startsWith("codex:") &&
            p.codexEntryId === node.id.slice("codex:".length)),
      );
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
    const pos = positions.find(
      (p) =>
        (contextMenu.nodeId.startsWith("scene:") &&
          p.treeNodeId === contextMenu.nodeId.slice("scene:".length)) ||
        (contextMenu.nodeId.startsWith("codex:") &&
          p.codexEntryId === contextMenu.nodeId.slice("codex:".length)),
    );
    if (!pos) return;
    const updated = await setNodePinned(pos.id, true);
    if (updated) {
      setPositions((prev) =>
        prev.map((p) =>
          p.id === updated.id ? (updated as MapNodePositionRecord) : p,
        ),
      );
    }
  }, [contextMenu, positions]);

  const handleContextMenuUnpin = useCallback(async () => {
    if (!contextMenu) return;
    const pos = positions.find(
      (p) =>
        (contextMenu.nodeId.startsWith("scene:") &&
          p.treeNodeId === contextMenu.nodeId.slice("scene:".length)) ||
        (contextMenu.nodeId.startsWith("codex:") &&
          p.codexEntryId === contextMenu.nodeId.slice("codex:".length)),
    );
    if (!pos) return;
    const updated = await setNodePinned(pos.id, false);
    if (updated) {
      setPositions((prev) =>
        prev.map((p) =>
          p.id === updated.id ? (updated as MapNodePositionRecord) : p,
        ),
      );
    }
  }, [contextMenu, positions]);

  const handleContextMenuHide = useCallback(async () => {
    if (!contextMenu || !boardId) return;
    const nodeId = contextMenu.nodeId;
    const pos = positions.find(
      (p) =>
        (nodeId.startsWith("scene:") &&
          p.treeNodeId === nodeId.slice("scene:".length)) ||
        (nodeId.startsWith("codex:") &&
          p.codexEntryId === nodeId.slice("codex:".length)),
    );
    if (pos) {
      await updateNodePosition(pos.id, { hidden: 1 });
      setPositions((prev) =>
        prev.map((p) => (p.id === pos.id ? { ...p, hidden: 1 } : p)),
      );
    } else {
      // No position record yet — create one with hidden=1
      const isScene = nodeId.startsWith("scene:");
      const newPos = await upsertNodePosition({
        boardId,
        nodeRefType: isScene ? "scene" : "codex",
        treeNodeId: isScene ? nodeId.slice("scene:".length) : null,
        codexEntryId: !isScene ? nodeId.slice("codex:".length) : null,
        x: 0,
        y: 0,
      });
      await updateNodePosition(newPos.id, { hidden: 1 });
      setPositions((prev) => [
        ...prev,
        { ...newPos, hidden: 1 } as MapNodePositionRecord,
      ]);
    }
  }, [contextMenu, boardId, positions]);

  const handleContextMenuOpen = useCallback(() => {
    if (!contextMenu) return;
    const sceneId = contextMenu.nodeId.slice("scene:".length);
    setActiveScene(sceneId);
  }, [contextMenu, setActiveScene]);

  // Sync viewport to store (debounced)
  const syncViewport = useDebouncedCallback(() => {
    const vp = getViewport();
    setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom });
  }, 300);

  // ── Frame drawing via overlay ──────────────────────────────────────────

  const handleFrameOverlayDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      frameDragStart.current = flowPos;
      setFrameDraftRect({ x: flowPos.x, y: flowPos.y, w: 0, h: 0 });
    },
    [screenToFlowPosition],
  );

  const handleFrameOverlayMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!frameDragStart.current) return;
      const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const dx = flowPos.x - frameDragStart.current.x;
      const dy = flowPos.y - frameDragStart.current.y;
      setFrameDraftRect({
        x: Math.min(flowPos.x, frameDragStart.current.x),
        y: Math.min(flowPos.y, frameDragStart.current.y),
        w: Math.abs(dx),
        h: Math.abs(dy),
      });
    },
    [screenToFlowPosition],
  );

  const handleFrameOverlayUp = useCallback(async () => {
    if (!frameDragStart.current || !boardId) return;
    const rect = frameDraftRect;
    frameDragStart.current = null;
    setFrameDraftRect(null);
    if (!rect || rect.w < 40 || rect.h < 40) return;

    const newFrame = await createFrame({
      boardId,
      title: "Frame",
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
    });
    setFrames((prev) => [...prev, newFrame]);
    setPaletteMode("default");
  }, [boardId, frameDraftRect]);

  // Keyboard shortcuts
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        setPaletteMode("default");
        setSearchVisible(false);
        setFrameDraftRect(null);
        frameDragStart.current = null;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setSearchVisible(true);
      }
      if (
        e.key === "f" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        setPaletteMode((m) => (m === "frame" ? "default" : "frame"));
      }
    },
    [setSearchVisible],
  );

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
    const scenes = treeNodes.filter(
      (n) => n.nodeType === "scene" && !hiddenSceneIds.has(n.id),
    );

    const newPositions = autoArrange({
      type,
      allTreeNodes: treeNodes,
      scenes,
      positions,
      variant,
    });

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
  }, [
    pendingAutoArrange,
    boardId,
    treeNodes,
    positions,
    variant,
    setPendingAutoArrange,
  ]);

  return (
    <div
      style={{ width: "100%", height: "100%", position: "relative" }}
      onKeyDown={onKeyDown}
      tabIndex={0}
    >
      <ReactFlow
        nodes={nodes}
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
        nodesDraggable={
          mode === "free" && paletteMode === "default" && !modeTransitionActive
        }
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
          {frameDraftRect && frameDraftRect.w > 4 && frameDraftRect.h > 4 && (
            <div
              style={{
                position: "absolute",
                // frameDraftRect is in flow coords, but we render in screen space.
                // For now use a simple % of the container as approximation;
                // exact pixel mapping happens on commit via screenToFlowPosition.
                border: "2px dashed #534AB7",
                background: "rgba(83,74,183,0.06)",
                borderRadius: 4,
                pointerEvents: "none",
                // Rough screen preview: can't perfectly align without flow→screen transform,
                // but the visual hint is enough for UX purposes.
                top: 0,
                left: 0,
                width: "100%",
                height: "100%",
                opacity: 0,
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
          onClose={() => setContextMenu(null)}
          onOpen={handleContextMenuOpen}
          onPin={handleContextMenuPin}
          onUnpin={handleContextMenuUnpin}
          onHide={handleContextMenuHide}
        />
      )}

      {pendingAutoArrange && (
        <AutoArrangeDialog
          type={pendingAutoArrange}
          onConfirm={executeAutoArrange}
          onCancel={() => setPendingAutoArrange(null)}
        />
      )}

      <MapPalette
        paletteMode={paletteMode}
        onPaletteModeChange={setPaletteMode}
      />
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
