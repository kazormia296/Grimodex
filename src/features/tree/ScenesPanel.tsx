import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { GripVertical } from "lucide-react";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import type { DragMoveEvent } from "@dnd-kit/core";
import { useTreeStore } from "./treeStore";
import { useScenesDerivedData } from "./useScenesDerivedData";
import { useScenesDnd } from "./useScenesDnd";
import { useScenesKeyboard } from "./useScenesKeyboard";
import { useLabelStore } from "@/features/labels/labelStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { buildSceneThreadTracks } from "@/features/plot-threads/sceneThreadTracks";
import { useTimelineStore } from "@/features/timeline/timelineStore";
import { useLensStore } from "@/features/post-effect/lensStore";
import { ManageLabelsDialog } from "@/features/labels/ManageLabelsDialog";
import { ScenesPanelContext } from "./ScenesPanelContext";
import type { OpenAiTreeArgs } from "./ScenesPanelContext";
import { AiTreeDialog } from "./aiScaffold/AiTreeDialog";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTabStore } from "@/features/editor/tabStore";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import { NodeIcon } from "./TreeNodeItem";
import { StructureTemplatePicker } from "@/features/grid/StructureTemplatePicker";
import { StatusDot } from "./StatusDot";
import { SynopsisArea } from "./SynopsisArea";
import type { NodeType } from "./treeStore";
import { motion, AnimatePresence } from "motion/react";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { BottomDropZone } from "./BottomDropZone";
import { TreeRenderer } from "./TreeRenderer";
import { RootContextMenu } from "./RootContextMenu";
import { ScenesToolbar } from "./ScenesToolbar";
import { ScenesFilterBar } from "./ScenesFilterBar";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useDropTarget } from "@/features/trash-bin/useDropTarget";
import { recordMark } from "@/lib/perfLog";
import { useExternalRootStore } from "@/features/external-mount/externalRootStore";
import { TreeRowSkeletonList } from "@/components/ui/skeleton-patterns";
import {
  selectProviderReadiness,
  useAiSettingsStore,
} from "@/features/chat/store";

const EMPTY_CHAR_COUNTS: Record<string, number> = {};

export function ScenesPanel() {
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const selectedIds = useTreeStore((s) => s.selectedIds);
  const isLoading = useTreeStore((s) => s.isLoading);
  const expandedIds = useTreeStore((s) => s.expandedIds);
  const filterQuery = useTreeStore((s) => s.filterQuery);
  const viewMode = useTreeStore((s) => s.viewMode);
  const sortMode = useTreeStore((s) => s.sortMode);
  const statusFilter = useTreeStore((s) => s.statusFilter);
  const labelFilter = useTreeStore((s) => s.labelFilter);
  // charCounts is only needed reactively when sorting by wordcount; otherwise
  // we keep a stable empty constant so keystrokes don't re-render this panel.
  // Per-leaf charCount display is handled inside TreeNodeItem via a per-id
  // selector.
  const charCounts = useTreeStore((s) =>
    s.sortMode === "wordcount" ? s.charCounts : EMPTY_CHAR_COUNTS,
  );
  const threadFilter = useTreeStore((s) => s.threadFilter);
  const showWordCounts = useTreeStore((s) => s.showWordCounts);
  const showStatusDots = useTreeStore((s) => s.showStatusDots);
  const showLabelDots = useTreeStore((s) => s.showLabelDots);
  const showPlotThreadTrack = useTreeStore((s) => s.showPlotThreadTrack);
  const showAiAttribution = useTreeStore((s) => s.showAiAttribution);
  const autoRevealActiveScene = useTreeStore((s) => s.autoRevealActiveScene);
  const pendingRevealId = useTreeStore((s) => s.pendingRevealId);
  const projectId = useTreeStore((s) => s.projectId);
  const aiReadiness = useAiSettingsStore(selectProviderReadiness);
  const loadLens = useLensStore((s) => s.load);
  const mountInitialized = useExternalRootStore((s) => s.isInitialized);
  const createNode = useTreeStore((s) => s.createNode);
  const expandAll = useTreeStore((s) => s.expandAll);
  const collapseAll = useTreeStore((s) => s.collapseAll);
  const setFilterQuery = useTreeStore((s) => s.setFilterQuery);
  const setStatusFilter = useTreeStore((s) => s.setStatusFilter);
  const toggleLabelFilter = useTreeStore((s) => s.toggleLabelFilter);
  const clearLabelFilter = useTreeStore((s) => s.clearLabelFilter);
  const setLabelFilter = useTreeStore((s) => s.setLabelFilter);
  const toggleThreadFilter = useTreeStore((s) => s.toggleThreadFilter);
  const clearThreadFilter = useTreeStore((s) => s.clearThreadFilter);
  const setThreadFilter = useTreeStore((s) => s.setThreadFilter);
  const toggleExpand = useTreeStore((s) => s.toggleExpand);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);
  const moveNode = useTreeStore((s) => s.moveNode);
  const setPendingRenameId = useTreeStore((s) => s.setPendingRenameId);

  const reduced = useReducedMotion();
  const allLabels = useLabelStore((s) => s.labels);
  const nodeLabels = useLabelStore((s) => s.nodeLabels);
  const allThreads = usePlotThreadStore((s) => s.threads);
  const plotLinks = usePlotThreadStore((s) => s.links);
  const plotBranches = usePlotThreadStore((s) => s.branches);
  // Timeline の「重要度順に整列」をトラックの列順にも反映する（共有 display 設定）。
  const plotSubwaySort = useTimelineStore((s) => s.plotSubwaySort);

  // thread id → row, for resolving dot color/name (stable per threads change).
  const threadsById = useMemo(
    () => new Map(allThreads.map((th) => [th.id, th])),
    [allThreads],
  );
  // nodeId → plot-thread ids (membership). Built once from links so per-row
  // lookups are O(1) instead of filtering all links on every tree render.
  const nodeThreadIds = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const l of plotLinks) {
      const arr = m[l.nodeId] ?? (m[l.nodeId] = []);
      if (!arr.includes(l.threadId)) arr.push(l.threadId);
    }
    return m;
  }, [plotLinks]);

  // Drop dangling label IDs when labels are deleted/project changes
  useEffect(() => {
    if (labelFilter.length === 0) return;
    const validIds = new Set(allLabels.map((l) => l.id));
    const filtered = labelFilter.filter((id) => validIds.has(id));
    if (filtered.length !== labelFilter.length) {
      setLabelFilter(filtered);
    }
  }, [allLabels, labelFilter, setLabelFilter]);

  // Drop dangling thread IDs when threads are deleted/project changes
  useEffect(() => {
    if (threadFilter.length === 0) return;
    const validIds = new Set(allThreads.map((th) => th.id));
    const filtered = threadFilter.filter((id) => validIds.has(id));
    if (filtered.length !== threadFilter.length) {
      setThreadFilter(filtered);
    }
  }, [allThreads, threadFilter, setThreadFilter]);

  // meta_structure の lens を読み込み、Outline バッジ (LensDot) に供給する。
  useEffect(() => {
    if (projectId) void loadLens(projectId);
  }, [projectId, loadLens]);

  const filterRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const [manageLabelsOpen, setManageLabelsOpen] = useState(false);
  const [aiTree, setAiTree] = useState<OpenAiTreeArgs | null>(null);
  const scenesPanelContextValue = useMemo(
    () => ({
      openManageLabels: () => setManageLabelsOpen(true),
      openAiTree: (args: OpenAiTreeArgs) => setAiTree(args),
    }),
    [],
  );
  const [deleteConfirm, setDeleteConfirm] = useState<string[] | null>(null);

  // Tab restore runs after external-mount reconcile so node IDs in the tree
  // match persisted tab nodeIds (initializeExternalMounts → loadTree in App).
  useEffect(() => {
    if (!mountInitialized) return;
    const nodeIds = new Set(useTreeStore.getState().nodes.map((n) => n.id));
    void useTabStore
      .getState()
      .loadTabState(nodeIds)
      .then(() => {
        useTabStore.getState().initAutoSave();
      });
    return () => {
      useTabStore.getState().disposeAutoSave?.();
    };
  }, [mountInitialized]);

  const { childMap, nodeMap, leafDescendantsByFolder, flatNodes } =
    useScenesDerivedData({
      nodes,
      sortMode,
      charCounts,
      expandedIds,
      filterQuery,
      statusFilter,
      labelFilter,
      nodeLabels,
      threadFilter,
      nodeThreadIds,
    });

  // 縦版ミニ・タイムラインのトラックモデル（可視行の並び flatNodes に従う）。
  const trackModel = useMemo(
    () =>
      buildSceneThreadTracks(
        flatNodes,
        nodeThreadIds,
        threadsById,
        plotBranches,
        plotSubwaySort,
      ),
    [flatNodes, nodeThreadIds, threadsById, plotBranches, plotSubwaySort],
  );
  // 列の内容（id+色）が不変なら trackColumns 参照を保ち、行 memo の破綻を抑える。
  const trackColKey = trackModel.columns
    .map((c) => `${c.id}:${c.color ?? ""}`)
    .join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const trackColumns = useMemo(() => trackModel.columns, [trackColKey]);
  const trackCellByNode = trackModel.cellByNode;
  const trackConnectorByNode = trackModel.connectorByNode;

  // Auto-reveal active scene: scroll it into view when activeSceneId changes
  useEffect(() => {
    if (!autoRevealActiveScene || !treeRef.current) return;
    const el = treeRef.current.querySelector(
      `[data-node-id="${activeSceneId}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeSceneId, autoRevealActiveScene]);

  // Force-reveal when requested from outside (e.g. "Show in Scenes" tab context menu)
  useEffect(() => {
    if (!pendingRevealId || !treeRef.current) return;
    const id = pendingRevealId;
    useTreeStore.setState({ pendingRevealId: null });
    // Retry scroll until the element appears in the DOM (panel may still be mounting)
    let attempts = 0;
    const tryScroll = () => {
      const el = treeRef.current?.querySelector(`[data-node-id="${id}"]`);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      } else if (attempts++ < 10) {
        requestAnimationFrame(tryScroll);
      }
    };
    requestAnimationFrame(tryScroll);
  }, [pendingRevealId]);

  const handleToggleAll = useCallback(() => {
    const folderIds = nodes
      .filter((n) => n.nodeType === "folder")
      .map((n) => n.id);
    const allExpanded =
      folderIds.length > 0 && folderIds.every((id) => expandedIds.includes(id));
    if (allExpanded) collapseAll();
    else expandAll();
  }, [nodes, expandedIds, expandAll, collapseAll]);

  const handleCreate = useCallback(
    (type: NodeType) => {
      let parentId: string | null = null;
      const active = nodeMap[activeSceneId];
      if (active?.nodeType === "scene" || active?.nodeType === "note") {
        parentId = active.parentId;
      } else if (active?.nodeType === "folder") {
        parentId = active.id;
      }
      createNode({ nodeType: type, parentId, afterId: activeSceneId })
        .then((newNode) => {
          if (newNode.nodeType === "scene" || newNode.nodeType === "note") {
            openEditorDocument(
              {
                target: { kind: "scene", documentId: newNode.id },
                mode: "pinned",
                revealEditor: true,
                focusEditor: false,
                syncSceneContext: true,
              },
              defaultEditorNavigationPorts,
            );
          }
        })
        .catch(() => {});
    },
    [createNode, activeSceneId, nodeMap],
  );

  const initiateDelete = useCallback(
    (ids: string[]) => {
      // Recursively collect all descendant IDs (inclusive)
      function collectAll(id: string): string[] {
        return [id, ...(childMap[id] ?? []).flatMap(collectAll)];
      }

      // Check all descendants (including folder contents) for content/synopsis
      const liveCharCounts = useTreeStore.getState().charCounts;
      const needsConfirm = ids.flatMap(collectAll).some((id) => {
        const node = nodeMap[id];
        if (!node || node.nodeType === "folder") return false;
        return (liveCharCounts[id] ?? 0) > 0 || !!node.synopsis;
      });
      if (needsConfirm) {
        setDeleteConfirm(ids);
      } else {
        // Delete sequentially to avoid state race conditions
        ids
          .reduce(
            (p, id) => p.then(() => useTreeStore.getState().deleteNode(id)),
            Promise.resolve(),
          )
          .catch(() => {});
      }
    },
    [nodeMap, childMap],
  );

  const handleTreeKeyDown = useScenesKeyboard({
    flatNodes,
    nodeMap,
    activeSceneId,
    selectedIds,
    expandedIds,
    setActiveScene,
    toggleExpand,
    setPendingRenameId,
    initiateDelete,
    treeRef,
    filterRef,
  });

  const {
    sensors,
    draggingId,
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragOver,
    onDragCancel,
  } = useScenesDnd({
    nodeMap,
    childMap,
    flatNodes,
    moveNode,
    containerRef: treeRef,
  });

  // Shift+Click 範囲選択用。prop で渡すと filter/expand のたびに配列参照が
  // 変わり TreeNodeItem の memo が全行で破綻するため、ref 経由で最新を読む。
  const flatNodesRef = useRef(flatNodes);
  flatNodesRef.current = flatNodes;

  const activeNode = nodeMap[activeSceneId];

  // hooks の呼び出し順を一定に保つため早期 return より前に置く (React rules)。
  const trashDropRef = useDropTarget("scenes-panel", "scenes-panel");

  const showTreeSkeleton = isLoading && nodes.length === 0;

  const draggingNode = draggingId ? nodeMap[draggingId] : null;

  const __renderResult = (
    <ScenesPanelContext.Provider value={scenesPanelContextValue}>
      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragMove={(e) => {
          onDragMove(e);
          onDragOver(e as unknown as DragMoveEvent);
        }}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div
          ref={trashDropRef}
          data-droptarget-id="scenes-panel"
          className="relative flex h-full min-h-0 flex-col overflow-hidden data-[trash-drop-hover=true]:ring-2 data-[trash-drop-hover=true]:ring-primary/60 data-[trash-drop-hover=true]:ring-inset"
        >
          <ScenesToolbar
            onCreate={handleCreate}
            onToggleAll={handleToggleAll}
          />
          <ScenesFilterBar
            filterRef={filterRef}
            filterQuery={filterQuery}
            setFilterQuery={setFilterQuery}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            labelFilter={labelFilter}
            toggleLabelFilter={toggleLabelFilter}
            clearLabelFilter={clearLabelFilter}
            allLabels={allLabels}
            threadFilter={threadFilter}
            toggleThreadFilter={toggleThreadFilter}
            clearThreadFilter={clearThreadFilter}
            allThreads={allThreads}
          />

          {/* Tree */}
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                ref={treeRef}
                className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1 outline-none"
                tabIndex={0}
                onKeyDown={handleTreeKeyDown}
              >
                {showTreeSkeleton ? (
                  <TreeRowSkeletonList testId="scenes-panel-loading" />
                ) : nodes.length === 0 ? (
                  <div
                    data-testid="scenes-empty-state"
                    className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center"
                  >
                    <p className="text-xs text-muted-foreground">
                      {t("scenes.empty")}
                    </p>
                    <StructureTemplatePicker
                      projectId={projectId}
                      containerId={null}
                    />
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={aiReadiness !== "ready"}
                      onClick={() =>
                        setAiTree({ mode: "scaffold", rootRef: null })
                      }
                    >
                      <Sparkles size={12} className="mr-1" />
                      {t("aiTree.scaffoldCta", "AI でアウトライン生成")}
                    </Button>
                  </div>
                ) : (
                  <>
                    <ul className="list-none">
                      <TreeRenderer
                        parentId={null}
                        childMap={childMap}
                        nodeMap={nodeMap}
                        depth={0}
                        activeSceneId={activeSceneId}
                        selectedIds={selectedIds}
                        expandedIds={expandedIds}
                        filterQuery={filterQuery}
                        statusFilter={statusFilter}
                        labelFilter={labelFilter}
                        nodeLabels={nodeLabels}
                        threadFilter={threadFilter}
                        nodeThreadIds={nodeThreadIds}
                        trackColumns={trackColumns}
                        cellByNode={trackCellByNode}
                        connectorByNode={trackConnectorByNode}
                        viewMode={viewMode}
                        showWordCounts={showWordCounts}
                        showStatusDots={showStatusDots}
                        showLabelDots={showLabelDots}
                        showPlotThreadTrack={showPlotThreadTrack}
                        showAiAttribution={showAiAttribution}
                        leafDescendantsByFolder={leafDescendantsByFolder}
                        orderedNodesRef={flatNodesRef}
                        dragInProgress={draggingId !== null}
                      />
                    </ul>
                    <BottomDropZone />
                  </>
                )}
              </div>
            </ContextMenuTrigger>
            <RootContextMenu createNode={createNode} />
          </ContextMenu>

          {/* Synopsis area — hidden in Outline mode (synopsis is shown inline there) */}
          <AnimatePresence mode="wait">
            {viewMode !== "outline" &&
              (activeNode?.nodeType === "scene" ||
                activeNode?.nodeType === "folder") && (
                <motion.div
                  key="synopsis"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={
                    reduced
                      ? { duration: 0 }
                      : { duration: DURATIONS.fast, ease: EASINGS.easeOut }
                  }
                >
                  <SynopsisArea nodeId={activeSceneId} />
                </motion.div>
              )}
          </AnimatePresence>

          {deleteConfirm && (
            <DeleteConfirmDialog
              ids={deleteConfirm}
              childMap={childMap}
              nodeMap={nodeMap}
              onCancel={() => setDeleteConfirm(null)}
              onConfirm={() => setDeleteConfirm(null)}
            />
          )}
        </div>

        {/* Drag overlay — portaled to body to escape dockview's transform context
         which breaks position:fixed used by DragOverlay */}
        {createPortal(
          <DragOverlay dropAnimation={null}>
            {draggingNode && (
              <div className="flex items-center gap-0.5 rounded bg-background/80 px-1 py-0.5 text-sm shadow-lg ring-1 ring-primary">
                <span className="flex h-4 w-3 flex-shrink-0 items-center justify-center text-muted-foreground/50">
                  <GripVertical className="h-3 w-3" />
                </span>
                <span className="w-4 flex-shrink-0" />
                {draggingNode.nodeType === "scene" && showStatusDots ? (
                  <StatusDot status={draggingNode.status} />
                ) : (
                  <NodeIcon nodeType={draggingNode.nodeType} />
                )}
                <span className="block truncate text-xs leading-5">
                  {draggingNode.title}
                </span>
              </div>
            )}
          </DragOverlay>,
          document.body,
        )}

        <ManageLabelsDialog
          open={manageLabelsOpen}
          onClose={() => setManageLabelsOpen(false)}
        />

        {aiTree && (
          <AiTreeDialog
            open
            onClose={() => setAiTree(null)}
            mode={aiTree.mode}
            rootRef={aiTree.rootRef}
            rootTitle={aiTree.rootTitle}
          />
        )}
      </DndContext>
    </ScenesPanelContext.Provider>
  );
  recordMark(
    "scenesPanel.render",
    performance.now() - __perfStart,
    __perfStart,
  );
  return __renderResult;
}
