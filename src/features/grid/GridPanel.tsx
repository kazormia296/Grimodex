import { useCallback, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { Modifier } from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import { gridCollisionDetection } from "./gridCollisionDetection";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import { useSceneCodexPinsStore } from "@/features/codex/sceneCodexPinsStore";
import { useEnsureCodexTypeColors } from "@/features/codex/useEnsureCodexTypeColors";
import { useGridStore } from "./gridStore";
import { useGridDerivedData, useGridFlatSceneOrder } from "./gridSelectors";
import { useGridCardVisibility } from "./useGridCardVisibility";
import { GridHeader } from "./GridHeader";
import { GridContainerOutline } from "./GridContainerOutline";
import { GridContainerSceneColumn } from "./GridContainerSceneColumn";
import { GridDisplayToolbar } from "./GridDisplayToolbar";
import { ManageLabelsDialog } from "@/features/labels/ManageLabelsDialog";
import { GridColumn } from "./GridColumn";
import { GridLooseColumn } from "./GridLooseColumn";
import { GridStatusBar } from "./GridStatusBar";
import { GridSelectionToolbar } from "./GridSelectionToolbar";
import { StructureTemplatePicker } from "./StructureTemplatePicker";
import { moveScenesToChapter } from "./bulkSceneOps";
import { recordMark } from "@/lib/perfLog";
import { useGridPanelLifecycle } from "./useGridPanelLifecycle";
import { useGridDragController } from "./useGridDragController";

/**
 * Pin the DragOverlay's center to the pointer. The actual draggable element
 * for a column drag is the entire chapter column (≈ 320×600 px), but the
 * overlay we render is a small title pill. dnd-kit's default behavior anchors
 * the overlay to the active element's top-left, which leaves the pill far
 * from the cursor — visually disconnected. Snapping center-to-cursor keeps
 * the overlay under the pointer regardless of the active element's size.
 *
 * Inlined from `@dnd-kit/modifiers`'s snapCenterToCursor to avoid pulling in
 * the whole package for a single helper.
 */
const snapOverlayCenterToCursor: Modifier = ({
  activatorEvent,
  draggingNodeRect,
  transform,
}) => {
  if (!draggingNodeRect || !activatorEvent) return transform;
  const coords = getEventCoordinates(activatorEvent);
  if (!coords) return transform;
  return {
    ...transform,
    x:
      transform.x +
      (coords.x - draggingNodeRect.left) -
      draggingNodeRect.width / 2,
    y:
      transform.y +
      (coords.y - draggingNodeRect.top) -
      draggingNodeRect.height / 2,
  };
};

export function GridPanel() {
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const projectId = useTreeStore((s) => s.projectId);
  const moveNode = useTreeStore((s) => s.moveNode);
  const nodes = useTreeStore((s) => s.nodes);
  const deleteNode = useTreeStore((s) => s.deleteNode);

  const containerId = useGridStore((s) => s.containerId);
  const display = useGridStore((s) => s.display);
  const filter = useGridStore((s) => s.filter);
  const searchQuery = useGridStore((s) => s.searchQuery);
  const setContainerId = useGridStore((s) => s.setContainerId);
  const loadForProject = useGridStore((s) => s.loadForProject);
  const clearSelection = useGridStore((s) => s.clearSelection);
  const selectAll = useGridStore((s) => s.selectAll);
  const selectedSceneIds = useGridStore((s) => s.selectedSceneIds);
  const pendingRevealSceneId = useGridStore((s) => s.pendingRevealSceneId);
  const createNode = useTreeStore((s) => s.createNode);

  async function addChapter() {
    await createNode({ nodeType: "folder", parentId: containerId });
  }

  useEnsureCodexTypeColors();

  const pinsByScene = useSceneCodexPinsStore((s) => s.pinsByScene);

  const { chapters, looseScenes, orderedColumns, totalChapters, totalScenes } =
    useGridDerivedData(containerId);
  const flatOrder = useGridFlatSceneOrder(containerId);
  const orderedScenes = useMemo(
    () => [
      ...chapters.flatMap((chapter) =>
        chapter.descendants
          .filter((descendant) => descendant.node.nodeType === "scene")
          .map((descendant) => ({
            id: descendant.node.id,
            parentId: descendant.node.parentId,
          })),
      ),
      ...looseScenes.map((scene) => ({
        id: scene.id,
        parentId: scene.parentId,
      })),
    ],
    [chapters, looseScenes],
  );

  const toolbarOpen = useGridStore((s) => s.toolbarOpen);
  const setToolbarOpen = useGridStore((s) => s.setToolbarOpen);

  const [manageLabelsOpen, setManageLabelsOpen] = useState(false);
  const [deleteConfirmIds, setDeleteConfirmIds] = useState<string[] | null>(
    null,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const dragController = useGridDragController({
    nodes,
    orderedScenes,
    flatOrder,
    containerId,
    selectedSceneIds,
    moveNode,
  });
  const {
    activeDragNode,
    activeDragIsMultiSelect,
    dropIndicator,
    columnDropIndicator,
    axisLockOffsets,
    columnAxisLockOffsets,
    axisLockActive,
    columnAxisLockActive,
  } = dragController;

  useGridPanelLifecycle({
    projectId,
    loadForProject,
    pendingRevealSceneId,
    nodes,
    flatOrder,
    setContainerId,
    clearSelection,
    selectAll,
    panelRef,
    deleteConfirmOpen: deleteConfirmIds !== null,
  });

  // Click outside: clear selection
  function handlePanelClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    // If click landed directly on the panel background (not a card or button), clear selection
    if (
      target === panelRef.current ||
      (target.closest("[data-grid-scene-id]") === null &&
        !target.closest("button"))
    ) {
      clearSelection();
    }
  }

  // Bulk delete handler
  const handleDeleteScenes = useCallback(
    (ids: string[]) => {
      const charCounts = useTreeStore.getState().charCounts;
      const anyHasContent = ids.some((id) => {
        const n = nodes.find((node) => node.id === id);
        return n && ((charCounts[id] ?? n.charCount ?? 0) > 0 || !!n.synopsis);
      });
      if (anyHasContent) {
        setDeleteConfirmIds(ids);
      } else {
        clearSelection();
        for (const id of ids) void deleteNode(id);
      }
    },
    [nodes, clearSelection, deleteNode],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const nestedFolderIds = useMemo(() => {
    const ids: string[] = [];
    const walk = (parentId: string) => {
      for (const n of nodes) {
        if (n.parentId !== parentId || n.nodeType !== "folder") continue;
        ids.push(n.id);
        walk(n.id);
      }
    };
    for (const ch of chapters) walk(ch.folder.id);
    return ids;
  }, [nodes, chapters]);

  const allDisplayedScenes = useMemo(
    () => [
      ...chapters.flatMap((ch) =>
        ch.descendants
          .filter((d) => d.node.nodeType === "scene")
          .map((d) => d.node),
      ),
      ...looseScenes,
    ],
    [chapters, looseScenes],
  );

  const visibility = useGridCardVisibility({
    scenes: allDisplayedScenes,
    searchQuery,
    filter,
    pinsByScene,
  });

  const __renderResult = (
    <DndContext
      sensors={sensors}
      collisionDetection={gridCollisionDetection}
      modifiers={[snapOverlayCenterToCursor]}
      // dnd-kit デフォルトの "Optimized" 戦略は translate.x/y 変化で droppable
      // を全件 getBoundingClientRect する。Grid は ~27 droppable + 16 cards で
      // pointer move 毎に 15-25ms の layout thrashing になっていた。
      // axis-lock 中は GridPanel が自前 siblingRects を保持しており、drag 中に
      // 列やカードの実 rect が動く局面でも dnd-kit の measure 結果は使われない
      // ため、BeforeDragging に切替えて drag 開始時のみ measure する。
      measuring={{ droppable: { strategy: MeasuringStrategy.BeforeDragging } }}
      onDragStart={dragController.handleDragStart}
      onDragOver={dragController.handleDragOver}
      onDragEnd={dragController.handleDragEnd}
      onDragCancel={dragController.handleDragCancel}
    >
      <div
        ref={panelRef}
        className="relative flex h-full flex-col overflow-hidden"
        onClick={handlePanelClick}
      >
        <GridHeader
          containerId={containerId}
          projectId={projectId}
          chapterCount={totalChapters}
          nestedFolderIds={nestedFolderIds}
          onContainerChange={(id) => void setContainerId(projectId, id)}
          toolbarOpen={toolbarOpen}
          onToggleToolbar={() => setToolbarOpen(!toolbarOpen)}
          onManageLabels={() => setManageLabelsOpen(true)}
        />

        {toolbarOpen && <GridDisplayToolbar />}

        <GridContainerOutline containerId={containerId} />

        <ManageLabelsDialog
          open={manageLabelsOpen}
          onClose={() => setManageLabelsOpen(false)}
        />

        <div className="flex flex-1 gap-3 overflow-x-auto overflow-y-hidden p-4">
          {orderedColumns.map((entry) => {
            if (entry.kind === "chapter") {
              return (
                <GridColumn
                  key={entry.data.folder.id}
                  folder={entry.data.folder}
                  descendants={entry.data.descendants}
                  display={display}
                  visibility={visibility}
                  dropIndicator={dropIndicator}
                  columnDropIndicator={columnDropIndicator}
                  axisLockOffsets={axisLockOffsets}
                  columnAxisLockOffsetPx={columnAxisLockOffsets.get(
                    entry.data.folder.id,
                  )}
                  onRequestDeleteConfirm={handleDeleteScenes}
                  flatOrder={flatOrder}
                />
              );
            }
            if (entry.kind === "container") {
              return (
                <GridContainerSceneColumn
                  key={`container-${entry.folder.id}`}
                  folder={entry.folder}
                  scenes={entry.scenes}
                  display={display}
                  chapters={chapters.map((ch) => ch.folder)}
                  visibility={visibility}
                  dropIndicator={dropIndicator}
                  columnDropIndicator={columnDropIndicator}
                  axisLockOffsets={axisLockOffsets}
                  onRequestDeleteConfirm={handleDeleteScenes}
                  flatOrder={flatOrder}
                />
              );
            }
            return (
              <GridLooseColumn
                key="loose"
                containerId={containerId}
                scenes={entry.scenes}
                display={display}
                chapters={chapters.map((ch) => ch.folder)}
                visibility={visibility}
                dropIndicator={dropIndicator}
                columnDropIndicator={columnDropIndicator}
                axisLockOffsets={axisLockOffsets}
                onRequestDeleteConfirm={handleDeleteScenes}
                flatOrder={flatOrder}
              />
            );
          })}

          {chapters.length === 0 && looseScenes.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
              <p className="text-sm text-muted-foreground">
                {t(
                  "grid.empty",
                  "章がありません。「章を追加」から始めましょう。",
                )}
              </p>
              <StructureTemplatePicker
                projectId={projectId}
                containerId={containerId}
              />
            </div>
          )}

          {(chapters.length > 0 || looseScenes.length > 0) && (
            <button
              type="button"
              onClick={() => void addChapter().catch(() => {})}
              className="flex shrink-0 items-center justify-center self-stretch min-h-[8rem] w-14 rounded-lg border border-dashed border-border bg-transparent text-muted-foreground hover:text-foreground hover:bg-accent/30 hover:border-foreground/40 transition-colors font-mono text-[11px] tracking-widest"
              style={{ writingMode: "vertical-rl" }}
              title={t("grid.header.newChapter", "章を追加")}
            >
              ＋ {t("grid.header.newChapter", "章を追加")}
            </button>
          )}
        </div>

        <GridSelectionToolbar
          onMoveToChapter={(folderId) => {
            const ids = flatOrder.filter((id) => selectedSceneIds.has(id));
            if (ids.length === 0) return;
            clearSelection();
            void moveScenesToChapter(ids, folderId);
          }}
          onDelete={() => handleDeleteScenes(Array.from(selectedSceneIds))}
        />

        <GridStatusBar
          totalChapters={totalChapters}
          totalScenes={totalScenes}
          displayedScenes={allDisplayedScenes}
        />

        {deleteConfirmIds && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80">
            <div className="rounded-lg border border-border bg-popover p-4 shadow-xl w-72">
              <p className="text-sm font-medium mb-1">
                {t("scenes.deleteConfirmTitle", "削除の確認")}
              </p>
              <p className="text-xs text-muted-foreground mb-4">
                {t(
                  "scenes.deleteConfirmBody",
                  "{{count}}件のシーンに本文またはsynopsisがあります。削除してもよいですか？",
                  { count: deleteConfirmIds.length },
                )}
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  className="rounded px-3 py-1 text-xs border border-border hover:bg-accent"
                  onClick={() => setDeleteConfirmIds(null)}
                >
                  {t("common.cancel", "キャンセル")}
                </button>
                <button
                  type="button"
                  className="rounded px-3 py-1 text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => {
                    const ids = deleteConfirmIds;
                    setDeleteConfirmIds(null);
                    clearSelection();
                    for (const id of ids) void deleteNode(id);
                  }}
                >
                  {t("common.deleteConfirm", "削除する")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeDragNode && (
          <div
            className={`relative flex flex-col rounded-md border-2 border-primary bg-card shadow-xl ring-2 ring-primary/30 ${display.compactCards ? "w-56" : "w-80"}`}
            style={{
              opacity: axisLockActive || columnAxisLockActive ? 0 : 0.92,
              pointerEvents:
                axisLockActive || columnAxisLockActive ? "none" : undefined,
            }}
          >
            <div className="flex items-center gap-1 border-b px-3 py-2">
              <span className="flex-1 truncate text-sm font-semibold">
                {activeDragNode.title}
              </span>
            </div>
            {activeDragNode.synopsis && (
              <p className="line-clamp-2 px-3 py-1.5 text-[11px] text-muted-foreground">
                {activeDragNode.synopsis}
              </p>
            )}
            {activeDragIsMultiSelect && (
              <div className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                {selectedSceneIds.size}
              </div>
            )}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
  recordMark("gridPanel.render", performance.now() - __perfStart, __perfStart);
  return __renderResult;
}
