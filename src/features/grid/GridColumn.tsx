import { useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cn } from "@/lib/utils";
import { GridSceneCard } from "./GridSceneCard";
import { GridFolderCard } from "./GridFolderCard";
import {
  columnDraggableId,
  columnSlotId,
  columnEndId,
  columnEmptyId,
} from "./gridDndUtils";
import type { DropIndicator, ColumnDropIndicator } from "./gridDndUtils";
import type { GridDisplaySettings } from "./gridStore";
import type { GridDescendant } from "./gridSelectors";

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
}

export function GridColumn({
  folder,
  descendants,
  display,
  isDragOverlay,
  visibility,
  dropIndicator,
  columnDropIndicator,
}: Props) {
  const { t } = useTranslation();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const createNode = useTreeStore((s) => s.createNode);
  const updateNodeTitle = useTreeStore((s) => s.updateNodeTitle);
  const pendingRename = useTreeStore((s) => s.pendingRenameId);

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
    setTitleDraft(folder.title);
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  }

  function commitTitle() {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== folder.title) {
      void updateNodeTitle(folder.id, trimmed);
    }
    setEditingTitle(false);
  }

  async function addScene() {
    await createNode({ nodeType: "scene", parentId: folder.id });
  }

  const shouldAutoEdit = pendingRename === folder.id;
  const colWidth = display.compactCards ? "w-44" : "w-56";

  const sceneItems = descendants
    .filter((d) => d.node.nodeType === "scene")
    .map((d) => d.node);
  const visibleScenes = sceneItems.filter(
    (s) => visibility.get(s.id)?.passesFilter !== false,
  );
  const INDENT_PX = 12;

  // Column drop indicator (left/right gap when this column is the drop target)
  const isColDropBefore =
    columnDropIndicator?.targetId === folder.id &&
    columnDropIndicator.position === "before";
  const isColDropAfter =
    columnDropIndicator?.targetId === folder.id &&
    columnDropIndicator.position === "after";
  const isColDropNest =
    columnDropIndicator?.targetId === folder.id &&
    columnDropIndicator.position === "nest";
  const COL_GAP = display.compactCards ? 176 : 224; // w-44 = 11rem = 176px / w-56 = 14rem = 224px

  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setSlotRef(node);
      }}
      style={{
        paddingLeft: isColDropBefore ? COL_GAP : 0,
        paddingRight: isColDropAfter ? COL_GAP : 0,
        transition: "padding 120ms ease-out",
      }}
    >
      <div
        className={cn(
          `flex flex-col h-full ${colWidth} shrink-0 rounded-lg border bg-muted/30`,
          isDragging && "opacity-40",
          isSlotOver && !columnDropIndicator && "ring-2 ring-primary",
          isColDropNest && "ring-2 ring-primary bg-primary/10",
        )}
        style={{ transition: "opacity 120ms ease-out" }}
      >
        {/* Column header */}
        <div
          className="flex items-center gap-1 px-3 py-2 border-b cursor-grab active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          {editingTitle || shouldAutoEdit ? (
            <input
              ref={titleInputRef}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus={shouldAutoEdit}
              className="flex-1 min-w-0 rounded bg-accent px-1 py-0.5 text-sm font-semibold outline-none"
              value={titleDraft || (shouldAutoEdit ? folder.title : "")}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTitle();
                } else if (e.key === "Escape") {
                  setEditingTitle(false);
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
        </div>

        {/* Items: scenes (cards) + nested folders (folder cards), recursively flattened */}
        <div className="flex flex-col gap-2 p-2 flex-1 min-h-0 overflow-y-auto">
          {descendants.length === 0 ? (
            <div
              ref={setEmptyRef}
              className={cn(
                "flex-1 rounded-md border-2 border-dashed border-border min-h-16",
                "flex items-center justify-center text-[11px] text-muted-foreground",
                isEmptyOver && "border-primary bg-primary/5",
              )}
            >
              {t("grid.column.dropHere", "ここにドロップ")}
            </div>
          ) : (
            <>
              {descendants.map(({ node, depth }) => {
                const indentStyle =
                  depth > 0 ? { paddingLeft: depth * INDENT_PX } : undefined;
                if (node.nodeType === "folder") {
                  return (
                    <div key={node.id} style={indentStyle}>
                      <GridFolderCard
                        folder={node}
                        compact={display.compactCards}
                      />
                    </div>
                  );
                }
                const vis = visibility.get(node.id);
                if (vis && !vis.passesFilter) return null;
                return (
                  <div key={node.id} style={indentStyle}>
                    <GridSceneCard
                      scene={node}
                      display={display}
                      dimmed={vis !== undefined && !vis.matchesSearch}
                      dropIndicator={dropIndicator}
                    />
                  </div>
                );
              })}
              <div
                ref={setEndRef}
                className={cn(
                  "h-4 rounded transition-colors",
                  isEndOver && "bg-primary/20",
                )}
              />
            </>
          )}
        </div>

        <button
          className="flex items-center gap-1 px-3 py-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 border-t transition-colors rounded-b-lg"
          onClick={() => void addScene()}
        >
          <Plus className="h-3 w-3" />
          {t("grid.column.newScene", "+ シーンを追加")}
        </button>
      </div>
    </div>
  );
}
