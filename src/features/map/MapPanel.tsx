import { useCallback, useEffect, useRef, useState } from "react";
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
  applyNodeChanges,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useMapStore } from "./mapStore";
import {
  getOrCreateBoard,
  listNodePositions,
  upsertNodePosition,
} from "./mapApi";
import { SceneNode } from "./nodes/SceneNode";
import { CodexNode } from "./nodes/CodexNode";
import { MapHeader } from "./MapHeader";
import { MapPalette } from "./MapPalette";
import type { MapNodePositionRecord } from "./types";

const PROJECT_ID = "default-project";

const NODE_TYPES = {
  scene: SceneNode,
  codex: CodexNode,
};

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

function MapCanvasInner() {
  const treeNodes = useTreeStore((s) => s.nodes);
  const codexEntries = useCodexStore((s) => s.entries);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);

  const mode = useMapStore((s) => s.mode);
  const show = useMapStore((s) => s.show);
  const minimapVisible = useMapStore((s) => s.minimapVisible);
  const gridSnap = useMapStore((s) => s.gridSnap);
  const setViewport = useMapStore((s) => s.setViewport);

  const { getViewport } = useReactFlow();

  const [boardId, setBoardId] = useState<string | null>(null);
  const [positions, setPositions] = useState<MapNodePositionRecord[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // Load or create board + positions on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const board = await getOrCreateBoard(PROJECT_ID);
      if (cancelled) return;
      setBoardId(board.id);
      const pos = await listNodePositions(board.id);
      if (cancelled) return;
      setPositions(pos as MapNodePositionRecord[]);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Build React Flow nodes from tree nodes + codex entries + stored positions
  useEffect(() => {
    if (!boardId) return;

    const posMap = new Map<string, MapNodePositionRecord>();
    for (const p of positions) {
      if (p.treeNodeId) posMap.set(`scene:${p.treeNodeId}`, p);
      if (p.codexEntryId) posMap.set(`codex:${p.codexEntryId}`, p);
    }

    const sceneNodes: Node[] = show.scenes
      ? treeNodes
          .filter((n) => n.nodeType === "scene")
          .map((n, idx) => {
            const key = `scene:${n.id}`;
            const pos = posMap.get(key);
            return {
              id: `scene:${n.id}`,
              type: "scene",
              position: pos
                ? { x: pos.x, y: pos.y }
                : {
                    x: (idx % 5) * 220 + 40,
                    y: Math.floor(idx / 5) * 120 + 40,
                  },
              data: {
                title: n.title,
                status: n.status ?? "outline",
                wordCount: undefined,
              },
              draggable: mode === "free",
            };
          })
      : [];

    const codexNodes: Node[] = show.codex
      ? codexEntries.map((e, idx) => {
          const key = `codex:${e.id}`;
          const pos = posMap.get(key);
          return {
            id: `codex:${e.id}`,
            type: "codex",
            position: pos
              ? { x: pos.x, y: pos.y }
              : { x: (idx % 4) * 240 + 40, y: Math.floor(idx / 4) * 120 + 500 },
            data: {
              name: e.name,
              type: e.type,
              summary: e.summary ?? "",
              color: "#534AB7",
            },
            draggable: mode === "free",
          };
        })
      : [];

    setNodes([...sceneNodes, ...codexNodes]);
  }, [boardId, positions, treeNodes, codexEntries, show, mode]);

  // Build derived edges (Codex parent-child)
  useEffect(() => {
    if (!show.derivedEdges) {
      setEdges([]);
      return;
    }
    const derivedEdges: Edge[] = codexEntries
      .filter((e) => e.parentId != null)
      .map((e) => ({
        id: `derived:${e.id}->${e.parentId}`,
        source: `codex:${e.parentId}`,
        target: `codex:${e.id}`,
        style: { stroke: "#999", strokeDasharray: "4 2" },
        animated: false,
      }));
    setEdges(derivedEdges);
  }, [codexEntries, show.derivedEdges]);

  // Persist position changes (debounced)
  const persistPosition = useDebouncedCallback(
    async (nodeId: string, x: number, y: number) => {
      if (!boardId) return;
      if (nodeId.startsWith("scene:")) {
        const treeNodeId = nodeId.slice("scene:".length);
        await upsertNodePosition({
          boardId,
          nodeRefType: "scene",
          treeNodeId,
          x,
          y,
        });
      } else if (nodeId.startsWith("codex:")) {
        const codexEntryId = nodeId.slice("codex:".length);
        await upsertNodePosition({
          boardId,
          nodeRefType: "codex",
          codexEntryId,
          x,
          y,
        });
      }
    },
    500,
  );

  const onNodesChange: OnNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
      // Persist position changes
      for (const change of changes) {
        if (change.type === "position" && change.position && !change.dragging) {
          persistPosition(change.id, change.position.x, change.position.y);
        }
      }
    },
    [persistPosition],
  );

  const onEdgesChange: OnEdgesChange = useCallback(() => {}, []);

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

  // Sync viewport to store (debounced)
  const syncViewport = useDebouncedCallback(() => {
    const vp = getViewport();
    setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom });
  }, 300);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDoubleClick={onNodeDoubleClick}
        onMoveEnd={syncViewport}
        snapToGrid={gridSnap}
        snapGrid={[16, 16]}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls />
        {minimapVisible && (
          <MiniMap style={{ width: 120, height: 80 }} zoomable pannable />
        )}
      </ReactFlow>
      <MapPalette />
    </div>
  );
}

export function MapPanel() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "var(--color-canvas-bg, #f8f8f8)",
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
