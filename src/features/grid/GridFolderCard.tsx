import { useEffect, useRef, useState } from "react";
import { Folder, ChevronRight, GripVertical } from "lucide-react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGridStore } from "./gridStore";
import { cn } from "@/lib/utils";
import { columnDraggableId, columnNestId } from "./gridDndUtils";
import type { ColumnDropIndicator } from "./gridDndUtils";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { recordMark } from "@/lib/perfLog";
import { InlineSynopsisEditor } from "@/features/editor/InlineSynopsisEditor";
import { GridFolderCardContextMenu } from "./GridFolderCardContextMenu";
import { GridFolderMenu } from "./GridFolderMenu";
import { useQuiescentDraftParticipant } from "@/application/lifecycle/useQuiescentDraftParticipant";
import { useLatestValueDraftController } from "@/application/lifecycle/latestValueDraftController";
import type { QuiescenceParticipantFlushOptions } from "@/application/lifecycle/quiescenceParticipants";

interface Props {
  folder: TreeNodeData;
  compact?: boolean;
  isDragOverlay?: boolean;
  /** Live column-drop indicator from the enclosing column drag handler.
   *  Drives the 3-zone Y-axis insertion highlights (top/middle/bottom) when
   *  this card is the active drop target. */
  columnDropIndicator?: ColumnDropIndicator | null;
  /** Axis-locked scene drag: signed translateY pixels. Folder cards sit
   *  between scenes in the rendered list — when an axis-locked scene drag
   *  passes this folder, the folder must shift too so the visual matches the
   *  post-drop sort order. Same units / transition as GridSceneCard. */
  axisLockOffsetPx?: number;
}

export function GridFolderCard({
  folder,
  compact,
  isDragOverlay,
  columnDropIndicator,
  axisLockOffsetPx,
}: Props) {
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const nodes = useTreeStore((s) => s.nodes);
  const projectId = useTreeStore((s) => s.projectId);
  const setContainerId = useGridStore((s) => s.setContainerId);
  const collapsedFolderIds = useGridStore((s) => s.collapsedFolderIds);
  const toggleFolderCollapsed = useGridStore((s) => s.toggleFolderCollapsed);
  const updateNodeTitle = useTreeStore((s) => s.updateNodeTitle);
  const pendingRenameId = useTreeStore((s) => s.pendingRenameId);
  const setPendingRenameId = useTreeStore((s) => s.setPendingRenameId);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const editingTitleRef = useRef(false);
  const mountedRef = useRef(true);
  const titleController = useLatestValueDraftController(
    `grid-folder-title:${folder.id}`,
    folder.title,
    async (next) => {
      const trimmed = next.trim();
      if (trimmed && trimmed !== folder.title) {
        await updateNodeTitle(folder.id, trimmed);
      }
    },
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function startTitleEdit() {
    if (editingTitleRef.current) return;
    editingTitleRef.current = true;
    titleController.reset(folder.title);
    setTitleDraft(folder.title);
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  }

  async function commitTitleEdit(
    options?: QuiescenceParticipantFlushOptions,
  ): Promise<void> {
    if (!editingTitleRef.current) return;
    if (!titleController.latestValue.trim()) {
      titleController.reset(folder.title);
    } else {
      await titleController.save(options);
    }
    editingTitleRef.current = false;
    if (mountedRef.current) setEditingTitle(false);
  }

  function cancelTitleEdit() {
    editingTitleRef.current = false;
    titleController.reset(folder.title);
    if (mountedRef.current) setEditingTitle(false);
  }

  useQuiescentDraftParticipant({
    id: `grid-folder-title:${folder.id}`,
    enabled: editingTitle,
    isDirty: () => editingTitleRef.current && titleController.dirty,
    flush: commitTitleEdit,
    discard: cancelTitleEdit,
    recovery: () =>
      editingTitleRef.current
        ? {
            kind: "grid-folder-title",
            nodeId: folder.id,
            title: titleController.latestValue,
          }
        : null,
  });

  // Enter edit mode when something external requests rename via the global
  // pendingRenameId flag (context menu, newly-created node, future shortcut).
  // Clear the flag immediately so the effect doesn't re-fire on re-render.
  useEffect(() => {
    if (pendingRenameId === folder.id) {
      startTitleEdit();
      setPendingRenameId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRenameId, folder.id]);

  const { setNodeRef: setNestRef, isOver: isNestOver } = useDroppable({
    id: columnNestId(folder.id),
    data: { kind: "column-nest", folderId: folder.id },
    disabled: !!isDragOverlay,
  });

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: columnDraggableId(folder.id),
    data: { kind: "column", folderId: folder.id },
    disabled: !!isDragOverlay,
  });

  const isExpanded = !collapsedFolderIds.has(folder.id);

  // 3-zone Y-axis indicators driven by the column-drop computation. `nest`
  // (middle) shows a ring on the card; `before`/`after` (top/bottom 25%) show
  // a horizontal bar above/below — mirrors the Scenes panel insertion UI.
  const isDropBefore =
    columnDropIndicator?.targetId === folder.id &&
    columnDropIndicator.position === "before";
  const isDropAfter =
    columnDropIndicator?.targetId === folder.id &&
    columnDropIndicator.position === "after";
  const isDropInside =
    columnDropIndicator?.targetId === folder.id &&
    columnDropIndicator.position === "nest";

  const directScenes = nodes.filter(
    (n) => n.parentId === folder.id && n.nodeType === "scene",
  ).length;
  const directFolders = nodes.filter(
    (n) => n.parentId === folder.id && n.nodeType === "folder",
  ).length;
  const isEmpty = directScenes === 0 && directFolders === 0;

  function diveIn() {
    void setContainerId(projectId, folder.id);
  }

  function handleToggle(e: React.MouseEvent) {
    e.stopPropagation();
    toggleFolderCollapsed(folder.id);
  }

  const axisLockOffset = axisLockOffsetPx ?? 0;
  const [e0, e1, e2, e3] = EASINGS.easeOut;
  const axisLockTransition = reducedMotion
    ? "none"
    : `transform ${DURATIONS.fast}s cubic-bezier(${e0}, ${e1}, ${e2}, ${e3})`;

  const __renderResult = (
    <GridFolderCardContextMenu
      folderId={folder.id}
      isEmpty={isEmpty}
      isExpanded={isExpanded}
      onOpen={diveIn}
      onToggleCollapse={() => toggleFolderCollapsed(folder.id)}
    >
      <div
        ref={(node) => {
          setNestRef(node);
          setDragRef(node);
        }}
        data-grid-folder-id={folder.id}
        className={cn(
          "group relative flex flex-col rounded-md border-2 border-dashed border-border/60 bg-muted/30",
          "hover:border-primary/50 hover:bg-accent/40 transition-colors",
          "select-none",
          // Local hover fallback only when no computed indicator overrides it —
          // avoids double-highlighting and lets no-op rejections suppress the ring.
          isNestOver &&
            !columnDropIndicator &&
            "border-primary bg-primary/10 ring-2 ring-primary",
          isDropInside && "border-primary bg-primary/10 ring-2 ring-primary",
          isDragging && "opacity-40",
        )}
        style={{
          transform: axisLockOffset
            ? `translateY(${axisLockOffset}px)`
            : undefined,
          transition: axisLockOffset
            ? `${axisLockTransition}, opacity 120ms ease-out`
            : "opacity 120ms ease-out",
          willChange: axisLockOffset ? "transform" : undefined,
        }}
      >
        {isDropBefore && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-1 h-0.5 rounded-full bg-primary"
          />
        )}
        {isDropAfter && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -bottom-1 h-0.5 rounded-full bg-primary"
          />
        )}
        <div
          className={cn(
            "flex items-center gap-1.5",
            compact ? "px-2 py-1.5" : "px-3 py-2",
          )}
        >
          <button
            type="button"
            onClick={handleToggle}
            disabled={isEmpty}
            className={cn(
              "shrink-0 rounded p-0.5 transition-colors",
              !isEmpty && "hover:bg-accent",
              isEmpty && "opacity-30 cursor-default",
            )}
            title={
              isEmpty
                ? t("grid.folderCard.empty", "空")
                : isExpanded
                  ? t("grid.folderCard.collapse", "折りたたむ")
                  : t("grid.folderCard.expand", "中身を展開")
            }
            aria-expanded={isExpanded}
            aria-label={
              isExpanded
                ? t("grid.folderCard.collapse", "折りたたむ")
                : t("grid.folderCard.expand", "中身を展開")
            }
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 text-muted-foreground/80 transition-transform",
                isExpanded && "rotate-90",
              )}
            />
          </button>
          <button
            type="button"
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
            aria-label={t("grid.folderCard.dragHandle", "ドラッグして移動")}
            title={t("grid.folderCard.dragHandle", "ドラッグして移動")}
            className={cn(
              "shrink-0 rounded p-0.5 cursor-grab active:cursor-grabbing",
              "text-muted-foreground/40 opacity-0 group-hover:opacity-100",
              "hover:text-muted-foreground hover:bg-accent",
              "transition-opacity",
              isDragging && "opacity-100",
            )}
            data-testid="grid-folder-drag-handle"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          {editingTitle ? (
            <div className="flex flex-1 items-center gap-1.5 min-w-0">
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={titleInputRef}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                className="flex-1 min-w-0 rounded bg-accent px-1 py-0.5 text-sm font-semibold outline-none"
                value={titleDraft}
                onChange={(e) => {
                  titleController.markDirty(
                    e.target.value.trim() ? e.target.value : folder.title,
                  );
                  setTitleDraft(e.target.value);
                }}
                onBlur={() => void commitTitleEdit().catch(() => {})}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitTitleEdit().catch(() => {});
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelTitleEdit();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={diveIn}
              className="flex flex-1 items-center gap-1.5 min-w-0 text-left"
              title={t("grid.folderCard.diveIn", "クリックで中を表示")}
            >
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate text-sm font-semibold">
                {folder.title}
              </span>
            </button>
          )}
          {!editingTitle && (
            <GridFolderMenu
              folderId={folder.id}
              isEmpty={isEmpty}
              isExpanded={isExpanded}
              onOpen={diveIn}
              onToggleCollapse={() => toggleFolderCollapsed(folder.id)}
            />
          )}
        </div>
        {!isExpanded && (
          <div
            className={cn(
              "flex items-center gap-2 text-[10px] text-muted-foreground/80",
              compact ? "px-2 pb-1.5" : "px-3 pb-2",
            )}
          >
            {directScenes > 0 && (
              <span>
                {t("grid.folderCard.scenes", "{{n}} シーン", {
                  n: directScenes,
                })}
              </span>
            )}
            {directFolders > 0 && (
              <span>
                {t("grid.folderCard.folders", "{{n}} フォルダ", {
                  n: directFolders,
                })}
              </span>
            )}
            {isEmpty && (
              <span className="italic">{t("grid.folderCard.empty", "空")}</span>
            )}
          </div>
        )}
        {/* Phase 4 後続: chapter outline (folder.synopsis)。double-click で編集。
          expanded 時も表示する: scenes は親 column に sibling として展開され
          folder カード自体は「この folder は何の section か」のラベル役を続ける
          ため、構造役割としての outline を同時に見られた方が読み解きやすい。 */}
        <div className={cn(compact ? "px-2 pb-1.5" : "px-3 pb-2")}>
          <InlineSynopsisEditor
            nodeId={folder.id}
            synopsis={folder.synopsis ?? null}
            className="line-clamp-2 cursor-text rounded text-[11px] leading-snug text-muted-foreground hover:bg-accent/30"
            textareaClassName="w-full resize-none rounded border border-border bg-background px-1.5 py-1 text-[11px] leading-snug text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder={t("grid.column.addOutline", "＋ Outline を追加")}
            rows={3}
            triggerOn="doubleClick"
          />
        </div>
      </div>
    </GridFolderCardContextMenu>
  );
  recordMark(
    "gridFolderCard.render",
    performance.now() - __perfStart,
    __perfStart,
  );
  return __renderResult;
}
