import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
import {
  getCurrentProjectId,
  useCurrentProjectId,
} from "@/features/project/projectStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { captureMapStickyDeletion } from "@/features/trash-bin/captureHooks";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";
import { useDropTarget } from "@/features/trash-bin/useDropTarget";
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
import {
  EdgeContextMenu,
  type EdgeContextMenuState,
} from "./edges/EdgeContextMenu";
import { ForceLayoutProgress } from "./ForceLayoutProgress";
import { useMapExport } from "./hooks/useMapExport";
import { useFrameDrawing } from "./hooks/useFrameDrawing";
import { useMapKeyboard } from "./hooks/useMapKeyboard";
import { useMapBoardData } from "./hooks/useMapBoardData";
import { useMapBoardPersistence } from "./hooks/useMapBoardPersistence";
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
  getSticky,
  upsertNodePosition,
  createFrame,
  getAiBranchSnapshot,
  restoreAiBranchSnapshot,
  eraseAiBranchSnapshot,
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
import { findPosByNodeId, buildUpsertArgs } from "./utils/nodeIdCodec";
import type { MapNodePositionRecord } from "./types";
import type { MapEdge, MapFrame } from "@/db/schema";

/** Pure classification used by onDeleteSelected — exported for tests. */
export function partitionDeletableNodes(nodes: Node[]) {
  // Frames are map-only entities → delete the frame record itself.
  const frameNodes = nodes.filter(
    (n) => n.type === "frame" || n.id.startsWith("frame:"),
  );
  // Sticky and AI Branch are map-only entities → delete the entity itself.
  const immediateNodes = nodes.filter(
    (n) => n.id.startsWith("sticky:") || n.id.startsWith("ai_branch:"),
  );
  // Scene / Note / Codex / Snippet are shared with other panels → only
  // remove the board position (the underlying entity stays intact and
  // can still be deleted from its native panel).
  const removeFromBoardNodes = nodes.filter(
    (n) =>
      n.id.startsWith("scene:") ||
      n.id.startsWith("note:") ||
      n.id.startsWith("codex:") ||
      n.id.startsWith("snippet:"),
  );
  return { frameNodes, immediateNodes, removeFromBoardNodes };
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
  const viewport = useMapStore((s) => s.viewport);
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
    setViewport: setReactFlowViewport,
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
  } = useMapBoardData(useCurrentProjectId());

  useMapBoardPersistence();

  const [nodes, setNodes] = useState<Node[]>([]);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("default");
  const [pickerType, setPickerType] = useState<
    "scene" | "note" | "codex" | "snippet" | null
  >(null);
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

  const stickiesRef = useRef(stickies);
  stickiesRef.current = stickies;

  const userEdgesRef = useRef(userEdges);
  userEdgesRef.current = userEdges;

  const framesRef = useRef(frames);
  framesRef.current = frames;

  const groupDraggingRef = useRef<Set<string>>(new Set());
  const persistingRef = useRef<Set<string>>(new Set());

  const spawnRef = useRef<{
    vp: { x: number; y: number; zoom: number };
    count: number;
  } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const TRANSITION_MS = DURATIONS.slow * 1000 + 50;

  const isMountRef = useRef(true);
  const initialFitDoneRef = useRef(false);
  const lastAppliedBoardRef = useRef<string | null>(null);

  useEffect(() => {
    if (!boardId) return;
    if (lastAppliedBoardRef.current === boardId) return;
    lastAppliedBoardRef.current = boardId;
    initialFitDoneRef.current = false;
    setReactFlowViewport(
      { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
      { duration: 0 },
    );
  }, [boardId, viewport.x, viewport.y, viewport.zoom, setReactFlowViewport]);

  useEffect(() => {
    if (nodes.length === 0 || initialFitDoneRef.current) return;
    const hasSavedViewport =
      viewport.x !== 0 || viewport.y !== 0 || viewport.zoom !== 1;
    if (hasSavedViewport) {
      initialFitDoneRef.current = true;
      return;
    }
    initialFitDoneRef.current = true;
    fitView({ duration: 0 });
  }, [nodes.length, viewport.x, viewport.y, viewport.zoom, fitView]);

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
    if (!prev && forceLayoutRunning) {
      // Force layout started: open the transition window now so the nodes
      // rebuilt at sim completion already carry the animation class.
      setModeTransitionActive(true);
    } else if (prev && !forceLayoutRunning) {
      // Force layout finished: close the window once the CSS transition ends.
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
      // Capture the sticky's full state from DB BEFORE the delete so we can
      // restore on undo. Reading from DB (instead of stickiesRef) captures the
      // latest body even when StickyNode was still in editing mode and parent
      // state hadn't synced yet.
      const capturedSticky =
        (await getSticky(stickyId)) ??
        stickiesRef.current.find((s) => s.id === stickyId);
      const capturedPos = findPosByNodeId(
        positionsRef.current,
        `sticky:${stickyId}`,
      );

      // Call deleteSticky outside the state updater to avoid React Strict Mode double-invoke.
      await deleteSticky(stickyId);
      setStickies((prev) => prev.filter((s) => s.id !== stickyId));
      setDeletingStickyIds((prev) => {
        const next = new Set(prev);
        next.delete(stickyId);
        return next;
      });
      if (capturedPos) {
        setPositions((prev) => prev.filter((p) => p.id !== capturedPos.id));
      }

      if (
        capturedSticky &&
        capturedPos &&
        !useGlobalHistoryStore.getState().isReplaying
      ) {
        const cap = {
          sticky: { ...capturedSticky },
          position: { ...capturedPos },
        };

        // Trash 連携: 削除した Sticky をゴミ箱にキャプチャ。
        const trashTempId = `trash-sticky-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${cap.sticky.id}`;
        captureMapStickyDeletion({
          projectId: getCurrentProjectId(),
          sticky: cap.sticky,
          position: cap.position,
          tempId: trashTempId,
        });

        useGlobalHistoryStore.getState().push({
          kind: "map",
          label: "Sticky削除",
          async undo() {
            // 1500ms 以内 Ctrl+Z 吸収: trash 保留を cancel
            useTrashBinStore.getState().cancelPending({ tempId: trashTempId });
            const recreated = await createSticky({
              id: cap.sticky.id,
              boardId: cap.sticky.boardId,
              x: cap.position.x,
              y: cap.position.y,
              paletteId: cap.sticky.paletteId,
              colorSlot: cap.sticky.colorSlot,
              title: cap.sticky.title ?? undefined,
              body: cap.sticky.body,
            });
            setStickies((prev) => [...prev, recreated.sticky]);
            setPositions((prev) => [
              ...prev,
              recreated.position as MapNodePositionRecord,
            ]);
          },
          async redo() {
            await deleteSticky(cap.sticky.id);
            setStickies((prev) => prev.filter((s) => s.id !== cap.sticky.id));
            setPositions((prev) =>
              prev.filter((p) => p.id !== cap.position.id),
            );
          },
        });
      }
    },
    [setStickies, setPositions],
  );

  useMapNodes({
    boardId,
    positions,
    userEdges: userEdges.map((e) => ({
      fromPositionId: e.fromPositionId,
      toPositionId: e.toPositionId,
    })),
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
    setPositions,
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
      userEdgesRef,
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
    projectId: getCurrentProjectId(),
    positions,
    nodes,
    setPositions,
    setStickies,
    setDeletingStickyIds,
    setActiveScene,
    onAfterPromote: (targetType) => {
      if (targetType === "scene" || targetType === "note") {
        void useTreeStore.getState().loadTree(getCurrentProjectId());
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
        projectId: getCurrentProjectId(),
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

  // Map 専属エンティティ（Sticky / AI Branch）の本体削除。
  // Scene / Note / Codex / Snippet はマップ外に存在するため Delete キー
  // ではボードから外すだけ（partitionDeletableNodes 参照）で、本体削除
  // は各パネルの専用 UI から行う。
  const deleteEntityNodes = useCallback(
    async (nodesToDelete: Node[]) => {
      for (const node of nodesToDelete) {
        if (node.id.startsWith("sticky:")) {
          // 2-phase delete: trigger exit animation first; actual DB delete
          // happens in onStickyExitComplete after the animation completes.
          const stickyId = node.id.slice("sticky:".length);
          setDeletingStickyIds((prev) => new Set(prev).add(stickyId));
        } else if (node.id.startsWith("ai_branch:")) {
          const branchId = node.id.slice("ai_branch:".length);
          // Capture full state for undo, then perform the standard delete which
          // preserves derived stickies as orphans (aiBranchId → null).
          const snapshot = !useGlobalHistoryStore.getState().isReplaying
            ? await getAiBranchSnapshot(branchId)
            : null;
          await deleteAiBranch(branchId);
          setAiBranches((prev) => prev.filter((b) => b.id !== branchId));

          if (snapshot) {
            const cap = snapshot;
            useGlobalHistoryStore.getState().push({
              kind: "map",
              label: "AI Branch 削除",
              async undo() {
                // restoreAiBranchSnapshot re-links orphan stickies' aiBranchId
                // and re-inserts the branch row, branch position, and dashed edges.
                await restoreAiBranchSnapshot(cap);
                setAiBranches((prev) => [...prev, cap.branch]);
                setPositions((prev) => [
                  ...prev,
                  cap.branchPosition as MapNodePositionRecord,
                ]);
              },
              async redo() {
                await deleteAiBranch(cap.branch.id);
                setAiBranches((prev) =>
                  prev.filter((b) => b.id !== cap.branch.id),
                );
                setPositions((prev) =>
                  prev.filter((p) => p.id !== cap.branchPosition.id),
                );
              },
            });
          }
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
    [setPositions, setAiBranches],
  );

  const onDeleteSelected = useCallback(async () => {
    if (!boardId) return;
    const selectedNodes = getNodes().filter((n) => n.selected);
    const selectedEdges = getEdges().filter((e) => e.selected);

    // Capture buckets are populated *after* a successful IPC, so the history
    // entry only contains rows that actually got removed from DB. A partial
    // failure during bulk delete leaves the surviving rows visible (state
    // wasn't filtered) and out of the history entry.
    const capturedEdges: MapEdge[] = [];
    for (const edge of selectedEdges) {
      if (!edge.id.startsWith("user:")) continue;
      const userEdgeId = edge.id.slice("user:".length);
      const original = userEdgesRef.current.find((u) => u.id === userEdgeId);
      try {
        await deleteUserEdge(userEdgeId);
      } catch (err) {
        toast.error("エッジ削除に失敗しました", { description: String(err) });
        continue;
      }
      if (original) capturedEdges.push({ ...original });
      setUserEdges((prev) => prev.filter((u) => u.id !== userEdgeId));
    }

    const { frameNodes, immediateNodes, removeFromBoardNodes } =
      partitionDeletableNodes(selectedNodes);

    const capturedFrames: MapFrame[] = [];
    for (const node of frameNodes) {
      const frameId = node.id.startsWith("frame:")
        ? node.id.slice("frame:".length)
        : node.id;
      const frame = framesRef.current.find((f) => f.id === frameId);
      try {
        await deleteFrame(frameId);
      } catch (err) {
        toast.error("Frame 削除に失敗しました", { description: String(err) });
        continue;
      }
      if (frame) capturedFrames.push({ ...frame });
      setFrames((prev) => prev.filter((f) => f.id !== frameId));
    }

    const capturedSnippetPositions: {
      nodeId: string;
      pos: MapNodePositionRecord;
    }[] = [];
    for (const node of removeFromBoardNodes) {
      const pos = findPosByNodeId(positionsRef.current, node.id);
      if (!pos) continue;
      try {
        await deleteNodePosition(pos.id);
      } catch (err) {
        toast.error("ボードからの削除に失敗しました", {
          description: String(err),
        });
        continue;
      }
      capturedSnippetPositions.push({ nodeId: node.id, pos: { ...pos } });
      setPositions((prev) => prev.filter((p) => p.id !== pos.id));
    }

    for (const node of immediateNodes) {
      try {
        await deleteEntityNodes([node]);
      } catch (err) {
        toast.error("ノード削除に失敗しました", { description: String(err) });
      }
    }

    // Push 1 bulk history entry for edges + snippet positions + frames deleted
    // in this pass. Entity nodes (Scene/Note/Codex/Sticky/AI branch) are
    // intentionally excluded — those deletions go through their own stores
    // which already push their own history entries.
    if (
      !useGlobalHistoryStore.getState().isReplaying &&
      (capturedEdges.length > 0 ||
        capturedSnippetPositions.length > 0 ||
        capturedFrames.length > 0)
    ) {
      const cap = {
        edges: capturedEdges,
        snippets: capturedSnippetPositions,
        frames: capturedFrames,
      };
      // Track upsertNodePosition's possibly-new ids for redo
      const liveSnippetIds = capturedSnippetPositions.map((s) => s.pos.id);
      const totalCount =
        cap.edges.length + cap.snippets.length + cap.frames.length;
      useGlobalHistoryStore.getState().push({
        kind: "map",
        label:
          totalCount === 1
            ? cap.edges.length === 1
              ? "エッジ削除"
              : cap.frames.length === 1
                ? "Frame削除"
                : "ボードから外す"
            : "複数削除",
        async undo() {
          for (const e of cap.edges) {
            await createUserEdge({
              id: e.id,
              boardId: e.boardId,
              fromPositionId: e.fromPositionId,
              toPositionId: e.toPositionId,
              forwardLabel: e.forwardLabel ?? undefined,
              backwardLabel: e.backwardLabel ?? undefined,
              style: e.style,
              color: e.color,
              direction: e.direction,
            });
          }
          if (cap.edges.length > 0) {
            setUserEdges((prev) => [...prev, ...cap.edges]);
          }

          const restored: MapNodePositionRecord[] = [];
          for (let i = 0; i < cap.snippets.length; i++) {
            const { nodeId, pos } = cap.snippets[i];
            const args = buildUpsertArgs(boardId, nodeId, pos.x, pos.y);
            if (!args) continue;
            const r = await upsertNodePosition(args);
            liveSnippetIds[i] = r.id;
            restored.push(r as MapNodePositionRecord);
          }
          if (restored.length > 0) {
            setPositions((prev) => [...prev, ...restored]);
          }

          const restoredFrames: MapFrame[] = [];
          for (const f of cap.frames) {
            const r = await createFrame({
              id: f.id,
              boardId: f.boardId,
              title: f.title ?? undefined,
              x: f.x,
              y: f.y,
              width: f.width,
              height: f.height,
              background: f.background ?? undefined,
              borderColor: f.borderColor ?? undefined,
            });
            restoredFrames.push(r);
          }
          if (restoredFrames.length > 0) {
            setFrames((prev) => [...prev, ...restoredFrames]);
          }
        },
        async redo() {
          for (const e of cap.edges) {
            await deleteUserEdge(e.id);
          }
          if (cap.edges.length > 0) {
            setUserEdges((prev) =>
              prev.filter((u) => !cap.edges.some((e) => e.id === u.id)),
            );
          }
          for (const id of liveSnippetIds) {
            await deleteNodePosition(id);
          }
          if (liveSnippetIds.length > 0) {
            setPositions((prev) =>
              prev.filter((p) => !liveSnippetIds.includes(p.id)),
            );
          }
          for (const f of cap.frames) {
            await deleteFrame(f.id);
          }
          if (cap.frames.length > 0) {
            setFrames((prev) =>
              prev.filter((fr) => !cap.frames.some((cf) => cf.id === fr.id)),
            );
          }
        },
      });
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

      if (!useGlobalHistoryStore.getState().isReplaying) {
        const captured = {
          sticky: { ...sticky.sticky },
          position: { ...sticky.position },
          boardId,
        };
        useGlobalHistoryStore.getState().push({
          kind: "map",
          label: "Sticky作成",
          async undo() {
            await deleteSticky(captured.sticky.id);
            setStickies((prev) =>
              prev.filter((s) => s.id !== captured.sticky.id),
            );
            setPositions((prev) =>
              prev.filter((p) => p.id !== captured.position.id),
            );
          },
          async redo() {
            const recreated = await createSticky({
              id: captured.sticky.id,
              boardId: captured.boardId,
              x: captured.position.x,
              y: captured.position.y,
              paletteId: captured.sticky.paletteId,
              colorSlot: captured.sticky.colorSlot,
              title: captured.sticky.title ?? undefined,
              body: captured.sticky.body,
            });
            setStickies((prev) => [...prev, recreated.sticky]);
            setPositions((prev) => [
              ...prev,
              recreated.position as MapNodePositionRecord,
            ]);
          },
        });
      }
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

    if (!useGlobalHistoryStore.getState().isReplaying) {
      const captured = {
        sticky: { ...result.sticky },
        position: { ...result.position },
        edge: { ...edge },
        sourcePosId: sourcePos.id,
        boardId,
      };
      useGlobalHistoryStore.getState().push({
        kind: "map",
        label: "分岐 Sticky 作成",
        async undo() {
          await deleteUserEdge(captured.edge.id);
          await deleteSticky(captured.sticky.id);
          setUserEdges((prev) => prev.filter((u) => u.id !== captured.edge.id));
          setStickies((prev) =>
            prev.filter((s) => s.id !== captured.sticky.id),
          );
          setPositions((prev) =>
            prev.filter((p) => p.id !== captured.position.id),
          );
        },
        async redo() {
          const recreatedSticky = await createSticky({
            id: captured.sticky.id,
            boardId: captured.boardId,
            x: captured.position.x,
            y: captured.position.y,
            paletteId: captured.sticky.paletteId,
            colorSlot: captured.sticky.colorSlot,
            title: captured.sticky.title ?? undefined,
            body: captured.sticky.body,
          });
          const recreatedEdge = await createUserEdge({
            id: captured.edge.id,
            boardId: captured.boardId,
            fromPositionId: captured.sourcePosId,
            toPositionId: recreatedSticky.position.id,
            forwardLabel: captured.edge.forwardLabel ?? undefined,
            backwardLabel: captured.edge.backwardLabel ?? undefined,
            style: captured.edge.style,
            color: captured.edge.color,
            direction: captured.edge.direction,
          });
          setStickies((prev) => [...prev, recreatedSticky.sticky]);
          setPositions((prev) => [
            ...prev,
            recreatedSticky.position as MapNodePositionRecord,
          ]);
          setUserEdges((prev) => [...prev, recreatedEdge]);
        },
      });
    }
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

        if (!useGlobalHistoryStore.getState().isReplaying) {
          // Capture full snapshot (includes edges + spans created internally)
          const snapshot = await getAiBranchSnapshot(result.branch.id);
          if (snapshot) {
            const cap = snapshot;
            const stickyIds = cap.stickies.map((s) => s.id);
            const posIds = cap.stickyPositions
              .map((p) => p.id)
              .concat(cap.branchPosition.id);
            useGlobalHistoryStore.getState().push({
              kind: "map",
              label: "AI Branch 生成",
              async undo() {
                await eraseAiBranchSnapshot(cap);
                setAiBranches((prev) =>
                  prev.filter((b) => b.id !== cap.branch.id),
                );
                setStickies((prev) =>
                  prev.filter((s) => !stickyIds.includes(s.id)),
                );
                setPositions((prev) =>
                  prev.filter((p) => !posIds.includes(p.id)),
                );
              },
              async redo() {
                await restoreAiBranchSnapshot(cap);
                setAiBranches((prev) => [...prev, cap.branch]);
                setStickies((prev) => [...prev, ...cap.stickies]);
                setPositions((prev) => [
                  ...prev,
                  cap.branchPosition as MapNodePositionRecord,
                  ...(cap.stickyPositions as MapNodePositionRecord[]),
                ]);
              },
            });
          }
        }
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
    userEdges: userEdges.map((e) => ({
      fromPositionId: e.fromPositionId,
      toPositionId: e.toPositionId,
    })),
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

  // Trash Bin の Map ペインへの drop ターゲット登録。
  // PhysicsView から渡される client 座標を screenToFlowPosition で flow 座標に変換し、
  // 既定の (0,0) ではなくドロップ点に Sticky を生成する (advisor が指摘した bug 修正)。
  const trashDropRef = useDropTarget("map-panel", "map-panel", {
    transformPoint: (client) => screenToFlowPosition(client),
  });
  const setRootRef = useCallback(
    (el: HTMLDivElement | null) => {
      wrapperRef.current = el;
      trashDropRef.current = el;
    },
    [trashDropRef],
  );

  return (
    <div
      ref={setRootRef}
      data-droptarget-id="map-panel"
      className={`${isCorkboard ? "map-corkboard " : ""}data-[trash-drop-hover=true]:ring-2 data-[trash-drop-hover=true]:ring-primary/60 data-[trash-drop-hover=true]:ring-inset`}
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
          onPicked={(pos) => {
            setPositions((prev) => {
              const idx = prev.findIndex((p) => p.id === pos.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = pos;
                return next;
              }
              return [...prev, pos];
            });
          }}
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
            const edgeId = edgeContextMenu.edgeId;
            const captured = userEdgesRef.current.find((u) => u.id === edgeId);
            await deleteUserEdge(edgeId);
            setUserEdges((prev) => prev.filter((u) => u.id !== edgeId));

            if (captured && !useGlobalHistoryStore.getState().isReplaying) {
              const cap = { ...captured };
              useGlobalHistoryStore.getState().push({
                kind: "map",
                label: "エッジ削除",
                async undo() {
                  const recreated = await createUserEdge({
                    id: cap.id,
                    boardId: cap.boardId,
                    fromPositionId: cap.fromPositionId,
                    toPositionId: cap.toPositionId,
                    forwardLabel: cap.forwardLabel ?? undefined,
                    backwardLabel: cap.backwardLabel ?? undefined,
                    style: cap.style,
                    color: cap.color,
                    direction: cap.direction,
                  });
                  setUserEdges((prev) => [...prev, recreated]);
                },
                async redo() {
                  await deleteUserEdge(cap.id);
                  setUserEdges((prev) => prev.filter((u) => u.id !== cap.id));
                },
              });
            }
          }}
        />
      )}
    </div>
  );
}
