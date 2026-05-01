import { useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cn } from "@/lib/utils";
import { GridSceneCard } from "./GridSceneCard";
import {
  columnDraggableId,
  columnSlotId,
  columnEndId,
  columnEmptyId,
} from "./gridDndUtils";
import type { GridDisplaySettings } from "./gridStore";

interface CardVisibility {
  matchesSearch: boolean;
  passesFilter: boolean;
}

interface Props {
  folder: TreeNodeData;
  scenes: TreeNodeData[];
  display: GridDisplaySettings;
  isDragOverlay?: boolean;
  visibility: Map<string, CardVisibility>;
}

export function GridColumn({
  folder,
  scenes,
  display,
  isDragOverlay,
  visibility,
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

  const visibleScenes = scenes.filter(
    (s) => visibility.get(s.id)?.passesFilter !== false,
  );

  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setSlotRef(node);
      }}
      className={cn(
        `flex flex-col ${colWidth} shrink-0 rounded-lg border bg-muted/30`,
        isDragging && "opacity-40",
        isSlotOver && "ring-2 ring-primary",
      )}
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
          {visibleScenes.length !== scenes.length && (
            <span className="opacity-50">/{scenes.length}</span>
          )}
        </span>
      </div>

      {/* Scene cards */}
      <div className="flex flex-col gap-2 p-2 flex-1">
        {scenes.length === 0 ? (
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
            {scenes.map((scene) => {
              const vis = visibility.get(scene.id);
              if (vis && !vis.passesFilter) return null;
              return (
                <GridSceneCard
                  key={scene.id}
                  scene={scene}
                  display={display}
                  dimmed={vis !== undefined && !vis.matchesSearch}
                />
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
  );
}
