import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useChatStore } from "@/features/chat/chatStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { createCodexMatcher } from "@/features/codex/codexMatcher";
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
  updateFrame,
  deleteFrame,
  listAINodes,
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
import type { MapAiNode, MapEdge, MapFrame } from "@/db/schema";
import { layoutFor, layoutForAsync } from "./layouts";
import { WorkerForceLayoutEngine } from "./layouts/forceEngine";
import { autoArrange, autoArrangeForceDirected } from "./layouts/autoArrange";
import { DURATIONS, useReducedMotion } from "@/lib/animation";
import { AutoArrangeDialog } from "./AutoArrangeDialog";
import { ForceLayoutProgress } from "./ForceLayoutProgress";
import { findPosByNodeId, buildUpsertArgs } from "./utils/nodeIdCodec";
import { useMapExport } from "./hooks/useMapExport";
import { useFrameDrawing } from "./hooks/useFrameDrawing";
import { useMapKeyboard } from "./hooks/useMapKeyboard";

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

  const [boardId, setBoardId] = useState<string | null>(null);
  const [positions, setPositions] = useState<MapNodePositionRecord[]>([]);
  const [userEdges, setUserEdges] = useState<MapEdge[]>([]);
  const [frames, setFrames] = useState<MapFrame[]>([]);
  const [aiNodes, setAiNodes] = useState<MapAiNode[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("default");
  const [showAINodeDialog, setShowAINodeDialog] = useState(false);
  const [modeTransitionActive, setModeTransitionActive] = useState(false);
  const [forceLayoutRunning, setForceLayoutRunning] = useState(false);
  const [forceAlpha, setForceAlpha] = useState(1);
  const [contextMenu, setContextMenu] = useState<{
    nodeId: string;
    screenPosition: { x: number; y: number };
    isPinned: boolean;
    isScene: boolean;
    isHidden: boolean;
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

  // Load board + positions + edges + frames on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const board = await getOrCreateBoard(PROJECT_ID);
      if (cancelled) return;
      setBoardId(board.id);
      const [pos, ue, fr, ai] = await Promise.all([
        listAllNodePositions(board.id),
        listUserEdges(board.id),
        listFrames(board.id),
        listAINodes(board.id),
      ]);
      if (cancelled) return;
      setPositions(pos as MapNodePositionRecord[]);
      setUserEdges(ue);
      setFrames(fr);
      setAiNodes(ai);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Build React Flow nodes: frames + scene nodes + codex nodes
  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;

    async function buildNodes() {
      // Derive visible/hidden sets from positions (hidden=1 persists across sessions)
      const hiddenTreeNodeIds = new Set(
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
        (n) => n.nodeType === "scene" && !hiddenTreeNodeIds.has(n.id),
      );
      const notes = treeNodes.filter(
        (n) => n.nodeType === "note" && !hiddenTreeNodeIds.has(n.id),
      );
      const visibleCodex = codexEntries.filter(
        (e) => !hiddenCodexIds.has(e.id),
      );

      let computedPositions;
      if (mode === "theme") {
        setForceLayoutRunning(true);
        setForceAlpha(1);
        const engine = new WorkerForceLayoutEngine();
        // Annotate each scene with the codex entry IDs it mentions (for Jaccard grouping)
        const themeMatcher = createCodexMatcher(visibleCodex);
        const scenesWithTags = scenes.map((s) => {
          const text = [s.title, s.synopsis].filter(Boolean).join(" ");
          const tags = [...new Set(themeMatcher(text).map((m) => m.entryId))];
          return { ...s, tags };
        });
        computedPositions = await layoutForAsync(
          "theme",
          {
            scenes: scenesWithTags,
            codexEntries: visibleCodex,
            positions: visiblePositions,
          },
          engine,
          (alpha) => {
            if (!cancelled) setForceAlpha(alpha);
          },
        );
        if (cancelled) return;
        setForceLayoutRunning(false);
      } else {
        computedPositions = layoutFor(mode, {
          scenes,
          codexEntries: visibleCodex,
          positions: visiblePositions,
        });
      }
      if (cancelled) return;

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

      // Build zIndex map from persisted positions
      const zIndexMap = new Map<string, number>();
      for (const p of visiblePositions) {
        if (p.treeNodeId && p.nodeRefType === "scene")
          zIndexMap.set(`scene:${p.treeNodeId}`, p.zIndex ?? 0);
        else if (p.treeNodeId && p.nodeRefType === "note")
          zIndexMap.set(`note:${p.treeNodeId}`, p.zIndex ?? 0);
        else if (p.codexEntryId)
          zIndexMap.set(`codex:${p.codexEntryId}`, p.zIndex ?? 0);
        else if (p.aiNodeId) zIndexMap.set(`ai:${p.aiNodeId}`, p.zIndex ?? 0);
      }

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
              draggable: true,
              zIndex: zIndexMap.get(key) ?? 0,
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
              zIndex: zIndexMap.get(key) ?? 0,
              data: {
                name: e.name,
                type: e.type,
                summary: e.summary ?? "",
                color: "#534AB7",
              },
            };
          })
        : [];

      // Note nodes use stored position directly (not part of layout engine)
      const notePosMap = new Map<string, { x: number; y: number }>();
      for (const p of visiblePositions) {
        if (p.treeNodeId && p.nodeRefType === "note") {
          notePosMap.set(`note:${p.treeNodeId}`, { x: p.x, y: p.y });
        }
      }
      const noteNodes: Node[] = show.notes
        ? notes.map((n, idx) => {
            const key = `note:${n.id}`;
            return {
              id: key,
              type: "note",
              position: notePosMap.get(key) ?? {
                x: 200 + (idx % 5) * 200,
                y: 600 + Math.floor(idx / 5) * 120,
              },
              className: transitionClass,
              draggable: true,
              zIndex: zIndexMap.get(key) ?? 0,
              data: {
                title: n.title,
                content: n.synopsis ?? "",
                onOpen: () => setActiveScene(n.id),
              },
            };
          })
        : [];

      // AI nodes use stored position directly
      const aiPosMap = new Map<string, { x: number; y: number }>();
      for (const p of visiblePositions) {
        if (p.aiNodeId) {
          aiPosMap.set(`ai:${p.aiNodeId}`, { x: p.x, y: p.y });
        }
      }
      const aiRfNodes: Node[] = show.ai
        ? aiNodes.map((an, idx) => {
            const key = `ai:${an.id}`;
            return {
              id: key,
              type: "ai",
              position: aiPosMap.get(key) ?? {
                x: 400 + (idx % 4) * 260,
                y: 800 + Math.floor(idx / 4) * 140,
              },
              className: transitionClass,
              draggable: true,
              zIndex: zIndexMap.get(key) ?? 0,
              data: {
                prompt: an.prompt,
                response: an.response,
                sessionId: an.sessionId,
                onOpenChat: () => {
                  if (an.sessionId) {
                    useChatStore.getState().selectSession(an.sessionId);
                  }
                },
              },
            };
          })
        : [];

      setNodes([
        ...frameNodes,
        ...sceneNodes,
        ...codexNodes,
        ...noteNodes,
        ...aiRfNodes,
      ]);
    }

    buildNodes();
    return () => {
      cancelled = true;
      setForceLayoutRunning(false);
    };
  }, [
    boardId,
    positions,
    treeNodes,
    codexEntries,
    aiNodes,
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
    const derived: Edge[] = [];

    if (show.derivedEdges) {
      // Codex parent-child edges
      for (const e of codexEntries.filter((e) => e.parentId != null)) {
        derived.push({
          id: `derived:${e.id}->${e.parentId}`,
          source: `codex:${e.parentId}`,
          target: `codex:${e.id}`,
          style: { stroke: "#999", strokeDasharray: "4 2" },
          animated: false,
          zIndex: 0,
        });
      }

      // Phase anchor edges: codex → scene (entryのフェーズがシーンに紐付く)
      const visibleSceneIds = new Set(
        treeNodes.filter((n) => n.nodeType === "scene").map((n) => n.id),
      );
      const visibleCodexIds = new Set(codexEntries.map((e) => e.id));
      for (const [entryId, phases] of Object.entries(phasesByEntry)) {
        if (!visibleCodexIds.has(entryId)) continue;
        for (const phase of phases) {
          if (!phase.anchorNodeId) continue;
          if (!visibleSceneIds.has(phase.anchorNodeId)) continue;
          derived.push({
            id: `phase-anchor:${phase.id}`,
            source: `codex:${entryId}`,
            target: `scene:${phase.anchorNodeId}`,
            style: { stroke: "#D97706", strokeDasharray: "3 3", opacity: 0.7 },
            animated: false,
            zIndex: 0,
            data: { label: phase.label },
          });
        }
      }

      // Build a single matcher for both scene-mention and snippet-origin
      if (codexEntries.length > 0) {
        const matcher = createCodexMatcher(codexEntries);

        // Scene mention edges: scene → codex (シーンのsynopsisでCodex名が登場)
        for (const scene of treeNodes.filter((n) => n.nodeType === "scene")) {
          const text = [scene.title, scene.synopsis].filter(Boolean).join(" ");
          if (!text) continue;
          const seen = new Set<string>();
          for (const m of matcher(text)) {
            if (seen.has(m.entryId)) continue;
            seen.add(m.entryId);
            if (!visibleCodexIds.has(m.entryId)) continue;
            derived.push({
              id: `mention:${scene.id}->${m.entryId}`,
              source: `scene:${scene.id}`,
              target: `codex:${m.entryId}`,
              style: {
                stroke: "#0891B2",
                strokeDasharray: "2 4",
                opacity: 0.6,
              },
              animated: false,
              zIndex: 0,
            });
          }
        }

        // Snippet origin edges: scene → codex (snippetのcontentでCodex名が登場)
        for (const snippet of snippetEntries.filter((s) => s.sceneId)) {
          const seenEdge = new Set<string>();
          for (const m of matcher(snippet.content)) {
            const key = `${snippet.sceneId}->${m.entryId}`;
            if (seenEdge.has(key)) continue;
            seenEdge.add(key);
            if (!visibleCodexIds.has(m.entryId)) continue;
            derived.push({
              id: `snippet-origin:${key}`,
              source: `scene:${snippet.sceneId!}`,
              target: `codex:${m.entryId}`,
              style: {
                stroke: "#059669",
                strokeDasharray: "1 4",
                opacity: 0.5,
              },
              animated: false,
              zIndex: 0,
            });
          }
        }
      }
    }

    const posToRfId = (
      pos: MapNodePositionRecord | undefined,
    ): string | null => {
      if (!pos) return null;
      if (pos.nodeRefType === "scene" && pos.treeNodeId)
        return `scene:${pos.treeNodeId}`;
      if (pos.nodeRefType === "note" && pos.treeNodeId)
        return `note:${pos.treeNodeId}`;
      if (pos.nodeRefType === "codex" && pos.codexEntryId)
        return `codex:${pos.codexEntryId}`;
      if (pos.nodeRefType === "ai" && pos.aiNodeId) return `ai:${pos.aiNodeId}`;
      return null;
    };

    const user: Edge[] = show.userEdges
      ? userEdges
          .map((ue) => {
            const fromPos = positions.find((p) => p.id === ue.fromPositionId);
            const toPos = positions.find((p) => p.id === ue.toPositionId);
            const sourceId = posToRfId(fromPos);
            const targetId = posToRfId(toPos);
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
  }, [
    codexEntries,
    userEdges,
    positions,
    show.derivedEdges,
    show.userEdges,
    treeNodes,
    phasesByEntry,
    snippetEntries,
  ]);

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
      } else if (nodeId.startsWith("note:")) {
        const treeNodeId = nodeId.slice("note:".length);
        const updated = await upsertNodePosition({
          boardId,
          nodeRefType: "note",
          treeNodeId,
          x,
          y,
        });
        setPositions((prev) => {
          const idx = prev.findIndex((p) => p.id === updated.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = updated as MapNodePositionRecord;
            return next;
          }
          return [...prev, updated as MapNodePositionRecord];
        });
      } else if (nodeId.startsWith("ai:")) {
        const aiNodeId = nodeId.slice("ai:".length);
        const updated = await upsertNodePosition({
          boardId,
          nodeRefType: "ai",
          aiNodeId,
          x,
          y,
        });
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

  // Node context menu handler
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      const pos = findPosByNodeId(positions, node.id);
      setContextMenu({
        nodeId: node.id,
        screenPosition: { x: event.clientX, y: event.clientY },
        isPinned: pos ? pos.pinned === 1 : false,
        isScene: node.id.startsWith("scene:"),
        isHidden: pos ? pos.hidden === 1 : false,
      });
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
  }, [contextMenu, positions]);

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
  }, [contextMenu, positions]);

  const handleContextMenuHide = useCallback(async () => {
    if (!contextMenu || !boardId) return;
    const nodeId = contextMenu.nodeId;
    const pos = findPosByNodeId(positions, nodeId);
    if (pos) {
      await updateNodePosition(pos.id, { hidden: 1 });
      setPositions((prev) =>
        prev.map((p) => (p.id === pos.id ? { ...p, hidden: 1 } : p)),
      );
    } else {
      // No position record yet — create one with hidden=1
      const args = buildUpsertArgs(boardId, nodeId);
      if (!args) return;
      const newPos = await upsertNodePosition(args);
      await updateNodePosition(newPos.id, { hidden: 1 });
      setPositions((prev) => [
        ...prev,
        { ...newPos, hidden: 1 } as MapNodePositionRecord,
      ]);
    }
  }, [contextMenu, boardId, positions]);

  const handleContextMenuShowHidden = useCallback(async () => {
    if (!contextMenu) return;
    const pos = findPosByNodeId(positions, contextMenu.nodeId);
    if (!pos) return;
    await updateNodePosition(pos.id, { hidden: 0 });
    setPositions((prev) =>
      prev.map((p) => (p.id === pos.id ? { ...p, hidden: 0 } : p)),
    );
  }, [contextMenu, positions]);

  const handleContextMenuOpen = useCallback(() => {
    if (!contextMenu) return;
    const sceneId = contextMenu.nodeId.slice("scene:".length);
    setActiveScene(sceneId);
  }, [contextMenu, setActiveScene]);

  // Helper: upsert position for any node type (returns existing or creates new)
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
  }, [contextMenu, positions, ensurePositionForNodeId]);

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
  }, [contextMenu, positions, ensurePositionForNodeId]);

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
