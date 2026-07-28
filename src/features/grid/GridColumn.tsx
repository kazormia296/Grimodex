import { useEffect, useMemo, useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { GripVertical, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cn } from "@/lib/utils";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { GridSceneCard } from "./GridSceneCard";
import { GridFolderCard } from "./GridFolderCard";
import { GridColumnLabelBar } from "./GridColumnLabelBar";
import { GridChapterColumnContextMenu } from "./GridChapterColumnContextMenu";
import { GridChapterColumnMenu } from "./GridChapterColumnMenu";
import { GridVirtualList } from "./GridVirtualList";
import { InlineSynopsisEditor } from "@/features/editor/InlineSynopsisEditor";
import {
  columnDraggableId,
  columnSlotId,
  columnEndId,
  columnEmptyId,
} from "./gridDndUtils";
import type { DropIndicator, ColumnDropIndicator } from "./gridDndUtils";
import type { GridDisplaySettings } from "./gridStore";
import type { GridDescendant } from "./gridSelectors";
import { useQuiescentDraftParticipant } from "@/application/lifecycle/useQuiescentDraftParticipant";
import { useLatestValueDraftController } from "@/application/lifecycle/latestValueDraftController";
import type { QuiescenceParticipantFlushOptions } from "@/application/lifecycle/quiescenceParticipants";

interface CardVisibility {
  matchesSearch: boolean;
  passesFilter: boolean;
}

interface Props {
  folder: TreeNodeData;
  /** All descendants (scenes + nested folders) in display order, with depth */
  descendants: GridDescendant[];
  display: GridDisplaySettings;
  isDragOverlay?: boolean;
  visibility: Map<string, CardVisibility>;
  dropIndicator?: DropIndicator | null;
  columnDropIndicator?: ColumnDropIndicator | null;
  /** Per-scene translateY pixel offsets during axis-locked scene drag.
   *  Includes the active card itself (multi-slot) so it visually travels
   *  with the swap rather than leaving a wandering empty slot. */
  axisLockOffsets?: Map<string, number>;
  /** Signed translateX pixels for axis-locked column drag. Negative = left,
   *  positive = right. Applies to passing sibling columns (one slot) and the
   *  active column itself (multi-slot) so it travels with the swap. */
  columnAxisLockOffsetPx?: number;
  onRequestDeleteConfirm?: (sceneIds: string[]) => void;
  /** Flat scene order across all columns, for range selection. */
  flatOrder?: string[];
  /** Keep only the active DnD source mounted when it leaves this viewport. */
  pinnedItemId?: string | null;
}

export function GridColumn({
  folder,
  descendants,
  display,
  isDragOverlay,
  visibility,
  dropIndicator,
  columnDropIndicator,
  axisLockOffsets,
  columnAxisLockOffsetPx,
  onRequestDeleteConfirm,
  flatOrder,
  pinnedItemId,
}: Props) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const editingTitleRef = useRef(false);
  const mountedRef = useRef(true);
  const createNode = useTreeStore((s) => s.createNode);
  const updateNodeTitle = useTreeStore((s) => s.updateNodeTitle);
  const pendingRenameId = useTreeStore((s) => s.pendingRenameId);
  const setPendingRenameId = useTreeStore((s) => s.setPendingRenameId);
  const titleController = useLatestValueDraftController(
    `grid-column-title:${folder.id}`,
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

  const { setNodeRef: setSlotRef, isOver: isSlotOver } = useDroppable({
    id: columnSlotId(folder.id),
    data: { kind: "column-slot", folderId: folder.id },
  });

  const { setNodeRef: setEndRef, isOver: isEndOver } = useDroppable({
    id: columnEndId(folder.id),
    data: { kind: "column-end", folderId: folder.id },
  });

  const { setNodeRef: setEmptyRef, isOver: isEmptyOver } = useDroppable({
    id: columnEmptyId(folder.id),
    data: { kind: "column-empty", folderId: folder.id },
  });

  function startTitleEdit() {
    if (editingTitleRef.current) return;
    editingTitleRef.current = true;
    titleController.reset(folder.title);
    setTitleDraft(folder.title);
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  }

  async function commitTitle(
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

  function cancelTitle(): void {
    editingTitleRef.current = false;
    titleController.reset(folder.title);
    if (mountedRef.current) setEditingTitle(false);
  }

  useQuiescentDraftParticipant({
    id: `grid-column-title:${folder.id}`,
    enabled: editingTitle,
    isDirty: () => editingTitleRef.current && titleController.dirty,
    flush: commitTitle,
    discard: cancelTitle,
    recovery: () =>
      editingTitleRef.current
        ? {
            kind: "grid-column-title",
            nodeId: folder.id,
            title: titleController.latestValue,
          }
        : null,
  });

  async function addScene() {
    await createNode({ nodeType: "scene", parentId: folder.id });
  }

  // Watch pendingRenameId (set by createNode for new folders, by the context
  // menu's "Rename" action, etc) and enter inline edit. Clear the flag on
  // entry so the effect doesn't re-fire after commit / on every re-render —
  // the previous `shouldAutoEdit = pendingRename === folder.id` derived flag
  // left the input rendered indefinitely once the global flag was set.
  useEffect(() => {
    if (pendingRenameId === folder.id) {
      startTitleEdit();
      setPendingRenameId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRenameId, folder.id]);

  const colWidth = display.compactCards ? "w-56" : "w-80";

  // Folder-aware axis-lock offset propagation. When an axis-lock drag passes a
  // folder, the folder card translates by ±activeSlot — but its rendered
  // descendants (depth+1, depth+2, ...) live as flat siblings in the column's
  // DOM, so they need the same translate applied to stay visually attached to
  // the folder block. Walk each descendant's parent chain (constrained to the
  // chapter's subtree) and inherit the closest ancestor folder's offset.
  const effectiveAxisLockOffsets = useMemo(() => {
    const base = axisLockOffsets ?? new Map<string, number>();
    if (base.size === 0) return base;
    const parentMap = new Map<string, string | null>();
    for (const d of descendants) parentMap.set(d.node.id, d.node.parentId);
    const result = new Map(base);
    for (const d of descendants) {
      if (result.has(d.node.id)) continue;
      let p = parentMap.get(d.node.id) ?? null;
      while (p && p !== folder.id) {
        if (result.has(p)) {
          result.set(d.node.id, result.get(p)!);
          break;
        }
        p = parentMap.get(p) ?? null;
      }
    }
    return result;
  }, [axisLockOffsets, descendants, folder.id]);

  const sceneItems = descendants
    .filter((d) => d.node.nodeType === "scene")
    .map((d) => d.node);
  const visibleScenes = sceneItems.filter(
    (s) => visibility.get(s.id)?.passesFilter !== false,
  );
  const renderedDescendants = useMemo(
    () =>
      descendants
        .filter(
          ({ node }) =>
            node.nodeType === "folder" ||
            visibility.get(node.id)?.passesFilter !== false,
        )
        .map((descendant) => ({
          ...descendant,
          id: descendant.node.id,
        })),
    [descendants, visibility],
  );
  const INDENT_PX = 12;

  // Column drop indicator (left/right insertion line when this column is the
  // drop target). The gap-opening animation was replaced with a static line —
  // see polish-motion: insertion animations were disabled, highlight only.
  const isColDropBefore =
    columnDropIndicator?.targetId === folder.id &&
    columnDropIndicator.position === "before";
  const isColDropAfter =
    columnDropIndicator?.targetId === folder.id &&
    columnDropIndicator.position === "after";
  const isColDropNest =
    columnDropIndicator?.targetId === folder.id &&
    columnDropIndicator.position === "nest";

  const axisLockTx = columnAxisLockOffsetPx ?? 0;
  const [e0, e1, e2, e3] = EASINGS.easeOut;
  const axisLockTransition = reducedMotion
    ? "none"
    : `transform ${DURATIONS.fast}s cubic-bezier(${e0}, ${e1}, ${e2}, ${e3})`;

  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setSlotRef(node);
      }}
      data-grid-folder-id={folder.id}
      className="relative"
      style={{
        transform: axisLockTx ? `translateX(${axisLockTx}px)` : undefined,
        transition: axisLockTransition,
        willChange: axisLockTx ? "transform" : undefined,
      }}
    >
      {isColDropBefore && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 -left-2 w-1 rounded-full bg-primary"
        />
      )}
      {isColDropAfter && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 -right-2 w-1 rounded-full bg-primary"
        />
      )}
      <GridChapterColumnContextMenu folderId={folder.id}>
        <div
          className={cn(
            `flex flex-col h-full ${colWidth} shrink-0 rounded-lg border bg-muted/30`,
            isDragging && "opacity-40",
            isSlotOver && !columnDropIndicator && "ring-2 ring-primary",
            isColDropNest && "ring-2 ring-primary bg-primary/10",
          )}
          style={{ transition: "opacity 120ms ease-out" }}
        >
          {display.showLabelBar && <GridColumnLabelBar nodeId={folder.id} />}

          {/* Column header */}
          <div className="group/colheader flex items-center gap-1 px-3 py-2 border-b">
            <button
              type="button"
              {...attributes}
              {...listeners}
              onClick={(e) => e.stopPropagation()}
              aria-label={t("grid.column.dragHandle", "ドラッグして並べ替え")}
              title={t("grid.column.dragHandle", "ドラッグして並べ替え")}
              className={cn(
                "shrink-0 rounded p-0.5 cursor-grab active:cursor-grabbing",
                "text-muted-foreground/40 opacity-0 group-hover/colheader:opacity-100",
                "hover:text-muted-foreground hover:bg-accent",
                "transition-opacity",
                isDragging && "opacity-100",
              )}
              data-testid="grid-column-drag-handle"
            >
              <GripVertical className="h-3.5 w-3.5" />
            </button>
            {editingTitle ? (
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
                onBlur={() => void commitTitle().catch(() => {})}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitTitle().catch(() => {});
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelTitle();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <button
                className="flex-1 min-w-0 text-left text-sm font-semibold truncate hover:text-accent-foreground"
                onDoubleClick={startTitleEdit}
                title={folder.title}
              >
                {folder.title}
              </button>
            )}
            <span className="text-[10px] text-muted-foreground shrink-0">
              {visibleScenes.length}
              {visibleScenes.length !== sceneItems.length && (
                <span className="opacity-50">/{sceneItems.length}</span>
              )}
            </span>
            {!editingTitle && <GridChapterColumnMenu folderId={folder.id} />}
          </div>

          {/* Phase 4 後続: chapter outline (folder.synopsis)。double-click で編集。
            chat に chapter outline として注入されるテキスト。 */}
          <div className="px-3 py-1.5 border-b">
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

          {/* Items: scenes (cards) + nested folders (folder cards), recursively flattened */}
          {descendants.length === 0 ? (
            <div className="flex min-h-0 flex-1 p-2">
              <div
                ref={setEmptyRef}
                className={cn(
                  "flex min-h-16 flex-1 items-center justify-center rounded-md border-2 border-dashed border-border",
                  "text-[11px] text-muted-foreground",
                  isEmptyOver && "border-primary bg-primary/5",
                )}
              >
                {t("grid.column.dropHere", "ここにドロップ")}
              </div>
            </div>
          ) : (
            <GridVirtualList
              items={renderedDescendants}
              pinnedItemId={pinnedItemId}
              compact={display.compactCards}
              endRef={setEndRef}
              endClassName={cn(
                "rounded transition-colors",
                isEndOver && "bg-primary/20",
              )}
              testId={`grid-column-list-${folder.id}`}
              renderItem={({ node, depth }) => {
                const indentStyle =
                  depth > 0 ? { paddingLeft: depth * INDENT_PX } : undefined;
                if (node.nodeType === "folder") {
                  return (
                    <div key={node.id} style={indentStyle}>
                      <GridFolderCard
                        folder={node}
                        compact={display.compactCards}
                        columnDropIndicator={columnDropIndicator}
                        axisLockOffsetPx={effectiveAxisLockOffsets.get(node.id)}
                      />
                    </div>
                  );
                }
                const vis = visibility.get(node.id);
                if (vis && !vis.passesFilter) return null;
                const isDropBefore =
                  (dropIndicator?.targetId === node.id &&
                    dropIndicator.position === "before") ||
                  (columnDropIndicator?.targetId === node.id &&
                    columnDropIndicator.position === "before");
                const isDropAfter =
                  (dropIndicator?.targetId === node.id &&
                    dropIndicator.position === "after") ||
                  (columnDropIndicator?.targetId === node.id &&
                    columnDropIndicator.position === "after");
                return (
                  <div style={indentStyle}>
                    <GridSceneCard
                      scene={node}
                      display={display}
                      dimmed={vis !== undefined && !vis.matchesSearch}
                      isDropBefore={isDropBefore}
                      isDropAfter={isDropAfter}
                      axisLockOffsetPx={effectiveAxisLockOffsets.get(node.id)}
                      onRequestDeleteConfirm={onRequestDeleteConfirm}
                      flatOrder={flatOrder}
                    />
                  </div>
                );
              }}
            />
          )}

          <button
            className="flex items-center gap-1 px-3 py-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 border-t transition-colors rounded-b-lg"
            onClick={() => void addScene().catch(() => {})}
          >
            <Plus className="h-3 w-3" />
            {t("grid.column.newScene", "シーンを追加")}
          </button>
        </div>
      </GridChapterColumnContextMenu>
    </div>
  );
}
