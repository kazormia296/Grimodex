import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  ViewportPortal,
  type Node,
  BackgroundVariant,
  useReactFlow,
  ConnectionMode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { listCodexRelations } from "@/features/codex/codexRelationApi";
import type { CodexRelationRow } from "@/features/codex/codexRelationApi";
import { subscribeCodexRelationsChanged } from "@/features/codex/codexRelationEvents";
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
import { useConfirmDialog } from "@/features/trash-bin/ConfirmDialog";
import { useSettingsStore } from "@/features/settings/settingsStore";
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
  promoteUserEdgeToCodexRelation,
  deleteFrame,
  deleteAiBranch,
  deleteSticky,
  adoptSticky,
  reattachSticky,
  adoptAllForBranch,
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
  pendingEdgeLabelEdits,
} from "./mapApi";
import { AINodeDialog } from "./AINodeDialog";
import { generateAiBranchCards, type AiBranchSeed } from "./mapAiApi";
import {
  collectAiBranchSeeds,
  fetchAiBranchProjectContext,
  fetchActiveSessionSpotlight,
} from "./aiBranchContext";
import { computeAiBranchLayout } from "./aiBranchLayout";
import {
  findNonOverlappingBranchPosition,
  type Rect as BranchRect,
} from "./branchPlacement";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { useAiGate } from "@/features/ai-policy/useAiGate";
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
    setCenter,
  } = useReactFlow();

  const reducedMotion = useReducedMotion();

  // AI Branch はチャット相当の自由生成 LLM 呼び出しなので chat トグルで gate。
  const aiBranchGate = useAiGate("chat");

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

  const [codexRelations, setCodexRelations] = useState<CodexRelationRow[]>([]);

  const projectId = useCurrentProjectId();
  const refreshCodexRelations = useCallback(async () => {
    if (!projectId) {
      setCodexRelations([]);
      return;
    }
    try {
      const rows = await listCodexRelations(projectId);
      setCodexRelations(rows);
    } catch {
      setCodexRelations([]);
    }
  }, [projectId]);
  useEffect(() => {
    void refreshCodexRelations();
  }, [refreshCodexRelations]);

  // Codex パネルからの relation 作成/削除を受けて derived relation overlay を更新する
  // (相関図 board 自体は snapshot なので影響しない)。
  useEffect(() => {
    if (!projectId) return;
    return subscribeCodexRelationsChanged(projectId, () => {
      void refreshCodexRelations();
    });
  }, [projectId, refreshCodexRelations]);

  // Stable projection of userEdges for layout/auto-arrange hooks. Without this
  // memo, the inline `.map()` would yield a fresh array every render, and the
  // effect in useMapNodes (which lists `userEdges` in its deps) would re-fire
  // every render → setNodes → re-render → loop (Maximum update depth exceeded).
  const layoutUserEdges = useMemo(
    () =>
      userEdges.map((e) => ({
        fromPositionId: e.fromPositionId,
        toPositionId: e.toPositionId,
      })),
    [userEdges],
  );

  const [nodes, setNodes] = useState<Node[]>([]);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("default");
  const [pickerType, setPickerType] = useState<
    "scene" | "note" | "codex" | "snippet" | null
  >(null);
  const [edgeContextMenu, setEdgeContextMenu] =
    useState<EdgeContextMenuState | null>(null);
  const [aiBranchDialog, setAiBranchDialog] = useState<{
    spawnPosition: { x: number; y: number };
    indicatorPosition: { x: number; y: number };
    seedNodeIds: string[];
    seedNodeTitles: string[];
    seeds: AiBranchSeed[];
  } | null>(null);
  // null = idle. spinner は seed ノード直下（indicatorPosition）に
  // ViewportPortal で flow 座標固定で出すため pan/zoom に追従する。
  const [generatingAiBranch, setGeneratingAiBranch] = useState<{
    indicatorPosition: { x: number; y: number };
  } | null>(null);
  const [modeTransitionActive, setModeTransitionActive] = useState(false);
  const [forceLayoutRunning, setForceLayoutRunning] = useState(false);
  const [forceAlpha, setForceAlpha] = useState(1);
  const [deletingStickyIds, setDeletingStickyIds] = useState<Set<string>>(
    new Set(),
  );

  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  // Forward-declared so useMapNodes (which runs above the actual handler
  // definition) can still inject a stable closure into each node's data.
  // The ref is updated below once the real handler exists.
  const handleBranchFromNodeRef = useRef<
    (sourceNodeId: string, dir: "left" | "right") => void
  >(() => {});
  // Stable identity — used in useMapNodes deps. Without useCallback this
  // would be a fresh arrow on every MapCanvas render, retriggering the
  // node-build useMemo → setNodes → StoreUpdater → infinite render loop.
  const stableOnBranchFromNode = useCallback(
    (id: string, dir: "left" | "right") =>
      handleBranchFromNodeRef.current(id, dir),
    [],
  );

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

  // 採用: AI Branch 由来 Sticky を branch から切り離して通常 Sticky 化する。
  // aiDerived (= AI 由来 provenance) は維持されるので onCopy は "ai" のまま。
  const stableOnAdoptSticky = useCallback(
    async (stickyId: string) => {
      const result = await adoptSticky(stickyId);
      setStickies((prev) =>
        prev.map((s) => (s.id === stickyId ? result.sticky : s)),
      );
      const removed = result.removedEdge;
      if (removed) {
        setUserEdges((prev) => prev.filter((e) => e.id !== removed.id));
      }
      const branchId = result.previousAiBranchId;
      if (branchId && !useGlobalHistoryStore.getState().isReplaying) {
        useGlobalHistoryStore.getState().push({
          kind: "map",
          label: "Sticky 採用",
          async undo() {
            await reattachSticky(stickyId, branchId, removed);
            setStickies((prev) =>
              prev.map((s) =>
                s.id === stickyId ? { ...s, aiBranchId: branchId } : s,
              ),
            );
            if (removed) setUserEdges((prev) => [...prev, removed]);
          },
          async redo() {
            await adoptSticky(stickyId);
            setStickies((prev) =>
              prev.map((s) =>
                s.id === stickyId ? { ...s, aiBranchId: null } : s,
              ),
            );
            if (removed) {
              setUserEdges((prev) => prev.filter((e) => e.id !== removed.id));
            }
          },
        });
      }
    },
    [setStickies, setUserEdges],
  );

  // 不採用: branch 由来 Sticky をゴミ箱へ。通常の Sticky 削除と同じ 2-phase
  // animated delete に流すだけ — onStickyExitComplete が trash キャプチャと
  // Undo 登録を行う (既存経路の再利用)。
  const stableOnRejectSticky = useCallback((stickyId: string) => {
    setDeletingStickyIds((prev) => new Set(prev).add(stickyId));
  }, []);

  useMapNodes({
    boardId,
    positions,
    userEdges: layoutUserEdges,
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
    onBranchFrom: stableOnBranchFromNode,
    onAdopt: stableOnAdoptSticky,
    onReject: stableOnRejectSticky,
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

  // インライン .map() だと毎レンダー新参照になり、ノードドラッグ中(setNodes が
  // pointermove 毎発火)に useMapEdges の useMemo を毎フレーム無効化 → codex matcher
  // の RegExp 再コンパイル + 全 scene 再走査を ~60fps で繰り返す（所見#3）。
  // codexRelations 自体が変わったときだけ作り直す。
  const codexRelationsForEdges = useMemo(
    () =>
      codexRelations.map((r) => ({
        id: r.id,
        fromCodexId: r.fromCodexId,
        toCodexId: r.toCodexId,
        label: r.label,
        relationType: r.relationType,
      })),
    [codexRelations],
  );

  const edges = useMapEdges({
    codexEntries,
    treeNodes,
    snippetEntries,
    phasesByEntry,
    userEdges,
    codexRelations: codexRelationsForEdges,
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
    handleToggleStickyChatPin,
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

  const { confirm: confirmDestructive, dialog: confirmDestructiveDialog } =
    useConfirmDialog();

  // 設計書 §「ワンクリック削除」: 右クリック → 派生 Sticky ごと一括削除。
  // `×` バッジは確認なしで AI Branch だけ消す path（派生 Sticky は orphan
  // 化）。こちらは派生 Sticky まで根こそぎ消すため件数表示の確認ダイアログ
  // を挟む。restoreAiBranchSnapshot による完全 undo に対応。
  const handleDeleteAiBranchWithDerived = useCallback(
    async (branchId: string) => {
      if (!boardId) return;
      const snapshot = await getAiBranchSnapshot(branchId);
      if (!snapshot) {
        setContextMenu(null);
        return;
      }
      const count = snapshot.stickies.length;
      setContextMenu(null);
      const ok = await confirmDestructive({
        title: "AI Branch を派生 Sticky ごと削除",
        description:
          count > 0
            ? `${count} 枚の派生 Sticky も一緒に削除されます。Undo で元に戻せます。`
            : "派生 Sticky はありません。AI Branch ノードを削除します。",
        confirmLabel: "削除",
      });
      if (!ok) return;
      try {
        await eraseAiBranchSnapshot(snapshot);
      } catch (err) {
        toast.error("AI Branch の一括削除に失敗しました", {
          description: String(err),
        });
        return;
      }
      const stickyIds = new Set(snapshot.stickies.map((s) => s.id));
      const removedPosIds = new Set([
        snapshot.branchPosition.id,
        ...snapshot.stickyPositions.map((p) => p.id),
      ]);
      const removedEdgeIds = new Set(snapshot.edges.map((e) => e.id));
      setAiBranches((prev) => prev.filter((b) => b.id !== branchId));
      setStickies((prev) => prev.filter((s) => !stickyIds.has(s.id)));
      setPositions((prev) => prev.filter((p) => !removedPosIds.has(p.id)));
      if (removedEdgeIds.size > 0) {
        setUserEdges((prev) => prev.filter((e) => !removedEdgeIds.has(e.id)));
      }

      if (!useGlobalHistoryStore.getState().isReplaying) {
        const cap = snapshot;
        useGlobalHistoryStore.getState().push({
          kind: "map",
          label: "AI Branch 一括削除",
          async undo() {
            await restoreAiBranchSnapshot(cap);
            setAiBranches((prev) => [...prev, cap.branch]);
            setStickies((prev) => [...prev, ...cap.stickies]);
            setPositions((prev) => [
              ...prev,
              cap.branchPosition as MapNodePositionRecord,
              ...(cap.stickyPositions as MapNodePositionRecord[]),
            ]);
            if (cap.edges.length > 0) {
              setUserEdges((prev) => [...prev, ...cap.edges]);
            }
          },
          async redo() {
            await eraseAiBranchSnapshot(cap);
            const reStickyIds = new Set(cap.stickies.map((s) => s.id));
            const rePosIds = new Set([
              cap.branchPosition.id,
              ...cap.stickyPositions.map((p) => p.id),
            ]);
            const reEdgeIds = new Set(cap.edges.map((e) => e.id));
            setAiBranches((prev) => prev.filter((b) => b.id !== cap.branch.id));
            setStickies((prev) => prev.filter((s) => !reStickyIds.has(s.id)));
            setPositions((prev) => prev.filter((p) => !rePosIds.has(p.id)));
            if (reEdgeIds.size > 0) {
              setUserEdges((prev) => prev.filter((e) => !reEdgeIds.has(e.id)));
            }
          },
        });
      }
    },
    [
      boardId,
      confirmDestructive,
      setContextMenu,
      setAiBranches,
      setStickies,
      setPositions,
      setUserEdges,
    ],
  );

  // 一括採用: AI Branch の派生 Sticky を全て branch から切り離して通常 Sticky 化。
  // 各 Sticky の aiBranchId を null にし、点線エッジを除去する。aiDerived (AI 由来
  // provenance) は保持されるので copy は "ai" のまま。単一 Undo で全件を branch に
  // 戻す (reattachSticky)。
  const handleAdoptAllForBranch = useCallback(
    async (branchId: string) => {
      setContextMenu(null);
      const results = await adoptAllForBranch(branchId);
      if (results.length === 0) return;
      const adoptedIds = new Set(results.map((r) => r.sticky.id));
      const removedEdgeIds = new Set(
        results
          .map((r) => r.removedEdge?.id)
          .filter((id): id is string => Boolean(id)),
      );
      setStickies((prev) =>
        prev.map((s) =>
          adoptedIds.has(s.id) ? { ...s, aiBranchId: null } : s,
        ),
      );
      if (removedEdgeIds.size > 0) {
        setUserEdges((prev) => prev.filter((e) => !removedEdgeIds.has(e.id)));
      }
      toast.success(`${results.length} 枚の Sticky を採用しました`);

      if (!useGlobalHistoryStore.getState().isReplaying) {
        const cap = results;
        useGlobalHistoryStore.getState().push({
          kind: "map",
          label: "Sticky 一括採用",
          async undo() {
            for (const r of cap) {
              if (r.previousAiBranchId) {
                await reattachSticky(
                  r.sticky.id,
                  r.previousAiBranchId,
                  r.removedEdge,
                );
              }
            }
            const reAdoptedIds = new Set(cap.map((r) => r.sticky.id));
            setStickies((prev) =>
              prev.map((s) =>
                reAdoptedIds.has(s.id)
                  ? {
                      ...s,
                      aiBranchId:
                        cap.find((r) => r.sticky.id === s.id)
                          ?.previousAiBranchId ?? s.aiBranchId,
                    }
                  : s,
              ),
            );
            const restoredEdges = cap
              .map((r) => r.removedEdge)
              .filter((e): e is NonNullable<typeof e> => Boolean(e));
            if (restoredEdges.length > 0) {
              setUserEdges((prev) => [...prev, ...restoredEdges]);
            }
          },
          async redo() {
            for (const r of cap) {
              await adoptSticky(r.sticky.id);
            }
            const reAdoptedIds = new Set(cap.map((r) => r.sticky.id));
            const reEdgeIds = new Set(
              cap
                .map((r) => r.removedEdge?.id)
                .filter((id): id is string => Boolean(id)),
            );
            setStickies((prev) =>
              prev.map((s) =>
                reAdoptedIds.has(s.id) ? { ...s, aiBranchId: null } : s,
              ),
            );
            if (reEdgeIds.size > 0) {
              setUserEdges((prev) => prev.filter((e) => !reEdgeIds.has(e.id)));
            }
          },
        });
      }
    },
    [setContextMenu, setStickies, setUserEdges],
  );

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
          // The DB cascades dashed branch→sticky edges via FK ON DELETE CASCADE
          // when the branch position is removed, but the client edge state has
          // to be cleared explicitly. Resolve via the branch position whether
          // or not we have a snapshot (replay path has no snapshot).
          const branchPos = positionsRef.current.find(
            (p) => p.nodeRefType === "ai_branch" && p.aiBranchId === branchId,
          );
          const cascadedEdgeIds = branchPos
            ? userEdgesRef.current
                .filter((e) => e.fromPositionId === branchPos.id)
                .map((e) => e.id)
            : [];
          await deleteAiBranch(branchId);
          setAiBranches((prev) => prev.filter((b) => b.id !== branchId));
          if (cascadedEdgeIds.length > 0) {
            setUserEdges((prev) =>
              prev.filter((e) => !cascadedEdgeIds.includes(e.id)),
            );
          }

          if (snapshot) {
            const cap = snapshot;
            const edgeIds = cap.edges.map((e) => e.id);
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
                if (cap.edges.length > 0) {
                  setUserEdges((prev) => [...prev, ...cap.edges]);
                }
              },
              async redo() {
                await deleteAiBranch(cap.branch.id);
                setAiBranches((prev) =>
                  prev.filter((b) => b.id !== cap.branch.id),
                );
                setPositions((prev) =>
                  prev.filter((p) => p.id !== cap.branchPosition.id),
                );
                if (edgeIds.length > 0) {
                  setUserEdges((prev) =>
                    prev.filter((e) => !edgeIds.includes(e.id)),
                  );
                }
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
    [setPositions, setAiBranches, setUserEdges, positionsRef, userEdgesRef],
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
        direction?: "none" | "forward" | "bidirectional";
      };
      const edgeId = edge.id.slice("user:".length);
      const ue = userEdgesRef.current.find((u) => u.id === edgeId);
      let canPromoteToRelation = false;
      if (ue) {
        const fromPosRec = positionsRef.current.find(
          (p) => p.id === ue.fromPositionId,
        );
        const toPosRec = positionsRef.current.find(
          (p) => p.id === ue.toPositionId,
        );
        canPromoteToRelation =
          fromPosRec?.nodeRefType === "codex" &&
          toPosRec?.nodeRefType === "codex" &&
          !!fromPosRec.codexEntryId &&
          !!toPosRec.codexEntryId;
      }
      setEdgeContextMenu({
        edgeId,
        screenPosition: { x: e.clientX, y: e.clientY },
        style: d.style ?? "solid",
        color: d.color ?? "#555555",
        direction: d.direction ?? "none",
        canPromoteToRelation,
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
      const settings = useSettingsStore.getState();
      const sticky = await createSticky({
        boardId,
        x: pos.x,
        y: pos.y,
        paletteId: settings.get(
          "map.defaultStickyPaletteId",
          "post-it-playful",
        ),
        colorSlot: settings.getNumber("map.defaultStickyColorSlot", 0),
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

  const handleBranchFromNode = useCallback(
    async (sourceNodeId: string, dir: "left" | "right" = "right") => {
      if (!boardId) return;
      const sourceNode = getNodes().find((n) => n.id === sourceNodeId);
      if (!sourceNode) return;
      const sourcePos = findPosByNodeId(positionsRef.current, sourceNodeId);
      if (!sourcePos) return;
      const sourceData = sourceNode.data as {
        paletteId?: string;
        colorSlot?: number;
      };
      const NEW_STICKY_W = 200;
      const NEW_STICKY_H = 120;
      const NODE_FALLBACK: Record<string, { w: number; h: number }> = {
        scene: { w: 180, h: 72 },
        codex: { w: 200, h: 90 },
        note: { w: 180, h: 72 },
        ai: { w: 160, h: 96 },
        sticky: { w: 240, h: 120 },
        snippet: { w: 200, h: 40 },
        ai_branch: { w: 200, h: 90 },
      };
      const existingRects: BranchRect[] = getNodes()
        .filter((n) => n.id !== sourceNodeId && !n.hidden)
        .map((n) => {
          const type = n.type ?? "sticky";
          const styleW =
            typeof n.style?.width === "number" ? n.style.width : undefined;
          const styleH =
            typeof n.style?.height === "number" ? n.style.height : undefined;
          const w =
            n.measured?.width ?? styleW ?? NODE_FALLBACK[type]?.w ?? 200;
          const h =
            n.measured?.height ?? styleH ?? NODE_FALLBACK[type]?.h ?? 120;
          return { x: n.position.x, y: n.position.y, w, h };
        });
      const { x: newX, y: newY } = findNonOverlappingBranchPosition(
        sourceNode.position,
        { w: NEW_STICKY_W, h: NEW_STICKY_H },
        dir,
        existingRects,
      );
      const result = await createSticky({
        boardId,
        x: newX,
        y: newY,
        paletteId: sourceData.paletteId,
        colorSlot: sourceData.colorSlot,
      });
      pendingAutoFocusIds.add(result.sticky.id);
      setStickies((prev) => [...prev, result.sticky]);
      setPositions((prev) => [
        ...prev,
        result.position as MapNodePositionRecord,
      ]);
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
            setUserEdges((prev) =>
              prev.filter((u) => u.id !== captured.edge.id),
            );
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
    },
    [boardId, getNodes, setStickies, setPositions, setUserEdges],
  );
  // Keep the forward-declared ref in sync so node data closures call the
  // latest implementation of handleBranchFromNode.
  handleBranchFromNodeRef.current = handleBranchFromNode;

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

  const handleOpenAiBranch = useCallback(
    (explicitSeedNodeId?: string) => {
      if (!boardId) return;
      // When invoked from a node context menu (explicitSeedNodeId), seed
      // from that node regardless of selection state. Otherwise fall back
      // to the current multi-node selection (Palette / keyboard path).
      // Frames have no meaningful body to feed the prompt, so they're
      // always excluded.
      const allNodes = getNodes();
      const seedNodes = explicitSeedNodeId
        ? allNodes.filter(
            (n) => n.id === explicitSeedNodeId && n.type !== "frame",
          )
        : allNodes.filter((n) => n.selected && n.type !== "frame");
      const seedNodeIds = seedNodes.map((n) => n.id);
      const seedNodeTitles = seedNodes
        .map((n) => {
          const data = n.data as { title?: string; name?: string };
          return data.title ?? data.name ?? n.id;
        })
        .filter(Boolean) as string[];
      // store にある最新 entity から body を抜き出して seed payload を構築。
      // 確認ダイアログ表示時点で確定させ、生成リクエスト時に再 fetch しない。
      const seeds = collectAiBranchSeeds(seedNodes, stickies, aiBranches);
      const spawnPosition = getSpawnPosition();
      // 進行中スピナーは seed ノードの bounding box の下端中央に
      // 出して「どのノードから派生中か」を視覚的に紐付ける。
      // seed が無い経路（Palette / shortcut で 0 選択時）は
      // spawn 位置にフォールバック。
      const indicatorPosition =
        seedNodes.length > 0
          ? (() => {
              const xs = seedNodes.map(
                (n) => n.position.x + (n.measured?.width ?? 0) / 2,
              );
              const bottoms = seedNodes.map(
                (n) => n.position.y + (n.measured?.height ?? 0),
              );
              return {
                x: xs.reduce((s, v) => s + v, 0) / xs.length,
                y: Math.max(...bottoms),
              };
            })()
          : spawnPosition;
      setAiBranchDialog({
        spawnPosition,
        indicatorPosition,
        seedNodeIds,
        seedNodeTitles,
        seeds,
      });
    },
    [boardId, getNodes, getSpawnPosition, stickies, aiBranches],
  );

  const handleAiBranchConfirm = useCallback(
    async (prompt: string, count: 3 | 5 | 8) => {
      if (!boardId || !aiBranchDialog) return;
      if (blockIfPolicyOff("chat")) return;
      const dialogState = aiBranchDialog;
      setAiBranchDialog(null);
      setGeneratingAiBranch({
        indicatorPosition: dialogState.indicatorPosition,
      });

      try {
        // project info と Spotlight pins を並列 fetch。失敗時はそれぞれ
        // null / [] にフォールバックして prompt のセクションが落ちるだけ。
        const [projectCtx, spotlight] = await Promise.all([
          fetchAiBranchProjectContext(getCurrentProjectId()),
          fetchActiveSessionSpotlight(),
        ]);
        const cards = await generateAiBranchCards(
          prompt,
          count,
          dialogState.seeds,
          projectCtx,
          spotlight,
        );

        const pos = dialogState.spawnPosition;
        // Place the card cluster in the most open region around the spawn,
        // avoiding overlap with existing on-board nodes.
        const layout = computeAiBranchLayout(
          pos.x,
          pos.y,
          cards.length,
          positionsRef.current.map((p) => ({ x: p.x, y: p.y })),
        );
        const result = await createAiBranch(
          boardId,
          prompt,
          dialogState.seedNodeIds,
          cards,
          {
            spawnX: layout.branch.x,
            spawnY: layout.branch.y,
            cardPositions: layout.cards,
          },
        );

        setAiBranches((prev) => [...prev, result.branch]);
        setStickies((prev) => [...prev, ...result.stickies]);
        setPositions((prev) => [
          ...prev,
          ...(result.positions as MapNodePositionRecord[]),
        ]);
        if (result.edges.length > 0) {
          setUserEdges((prev) => [...prev, ...result.edges]);
        }

        if (!useGlobalHistoryStore.getState().isReplaying) {
          // Capture full snapshot (includes edges + spans created internally)
          const snapshot = await getAiBranchSnapshot(result.branch.id);
          if (snapshot) {
            const cap = snapshot;
            const stickyIds = cap.stickies.map((s) => s.id);
            const posIds = cap.stickyPositions
              .map((p) => p.id)
              .concat(cap.branchPosition.id);
            const edgeIds = cap.edges.map((e) => e.id);
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
                setUserEdges((prev) =>
                  prev.filter((e) => !edgeIds.includes(e.id)),
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
                if (cap.edges.length > 0) {
                  setUserEdges((prev) => [...prev, ...cap.edges]);
                }
              },
            });
          }
        }
      } finally {
        setGeneratingAiBranch(null);
      }
    },
    [
      boardId,
      aiBranchDialog,
      setAiBranches,
      setStickies,
      setPositions,
      setUserEdges,
      positionsRef,
    ],
  );

  const { executeAutoArrange } = useMapAutoArrange({
    boardId,
    pendingAutoArrange,
    positions,
    userEdges: layoutUserEdges,
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
        {generatingAiBranch && (
          <ViewportPortal>
            <div
              style={{
                position: "absolute",
                // Anchor under the seed node(s) so the indicator stays
                // visually tied to the node being expanded. translate
                // centers horizontally and adds an 8px gap below.
                left: generatingAiBranch.indicatorPosition.x,
                top: generatingAiBranch.indicatorPosition.y + 8,
                transform: "translate(-50%, 0)",
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "6px 12px",
                fontSize: 12,
                color: "var(--foreground)",
                boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
                display: "flex",
                alignItems: "center",
                gap: 8,
                whiteSpace: "nowrap",
                pointerEvents: "none",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  border: "2px solid var(--border)",
                  borderTopColor: "var(--foreground)",
                  animation: "grimodex-spin 0.8s linear infinite",
                }}
              />
              <span>AI Branch を生成中…</span>
            </div>
          </ViewportPortal>
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
          isAiBranch={contextMenu.nodeId.startsWith("ai_branch:")}
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
            contextMenu.nodeId.startsWith("frame:")
              ? undefined
              : () => handleBranchFromNode(contextMenu.nodeId, "right")
          }
          onOpenAiBranch={
            contextMenu.nodeId.startsWith("frame:") ||
            aiBranchGate.presentation === "hidden"
              ? undefined
              : () => handleOpenAiBranch(contextMenu.nodeId)
          }
          onPinToChatContext={
            contextMenu.nodeId.startsWith("sticky:")
              ? handleToggleStickyChatPin
              : undefined
          }
          isStickyPinnedToChat={contextMenu.isStickyPinnedToChat}
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
          onDeleteWithDerivedStickies={
            contextMenu.nodeId.startsWith("ai_branch:")
              ? () =>
                  void handleDeleteAiBranchWithDerived(
                    contextMenu.nodeId.slice("ai_branch:".length),
                  )
              : undefined
          }
          onAdoptAllDerived={
            contextMenu.nodeId.startsWith("ai_branch:")
              ? () =>
                  void handleAdoptAllForBranch(
                    contextMenu.nodeId.slice("ai_branch:".length),
                  )
              : undefined
          }
          derivedStickyCount={
            contextMenu.nodeId.startsWith("ai_branch:")
              ? stickies.filter(
                  (s) =>
                    s.aiBranchId ===
                    contextMenu.nodeId.slice("ai_branch:".length),
                ).length
              : 0
          }
        />
      )}
      {confirmDestructiveDialog}

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
        onAddSticky={() => {
          void handleAddSticky();
        }}
        onOpenPicker={setPickerType}
        onOpenAiBranch={handleOpenAiBranch}
        aiBranchPresentation={aiBranchGate.presentation}
        aiBranchTooltip={aiBranchGate.tooltip}
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
          getSpawnPosition={getSpawnPosition}
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
            // 中心配置のズレ保険として挿入先にビューを寄せる。
            // getViewport().zoom を維持してパンだけ動かす。
            setCenter(pos.x, pos.y, {
              zoom: getViewport().zoom,
              duration: 400,
            });
          }}
          onClose={() => setPickerType(null)}
        />
      )}

      {edgeContextMenu && (
        <EdgeContextMenu
          {...edgeContextMenu}
          onClose={() => setEdgeContextMenu(null)}
          onEditLabel={(field) => {
            const edgeId = edgeContextMenu.edgeId;
            pendingEdgeLabelEdits.set(edgeId, field);
            // Force re-render so useMapEdges picks up the pending edit signal
            // and pipes it into the target InlineLabel.
            setUserEdges((prev) => [...prev]);
            setEdgeContextMenu(null);
          }}
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
          onDirectionChange={async (direction) => {
            const updated = await updateUserEdge(edgeContextMenu.edgeId, {
              direction,
            });
            if (updated)
              setUserEdges((prev) =>
                prev.map((u) =>
                  u.id === edgeContextMenu.edgeId ? updated : u,
                ),
              );
          }}
          onPromoteToRelation={async () => {
            const edgeId = edgeContextMenu.edgeId;
            const pid = getCurrentProjectId();
            const result = await promoteUserEdgeToCodexRelation(
              edgeId,
              pid,
              positionsRef.current,
            );
            if (!result) {
              toast.error("両端が Codex ノードの User edge のみ昇格できます");
              return;
            }
            setUserEdges((prev) => prev.filter((u) => u.id !== edgeId));
            await refreshCodexRelations();
            toast.success("Codex Relation に昇格しました");
            setEdgeContextMenu(null);
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
