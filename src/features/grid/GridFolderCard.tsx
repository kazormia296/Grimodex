import { Folder, ChevronRight } from "lucide-react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGridStore } from "./gridStore";
import { cn } from "@/lib/utils";
import { columnDraggableId, columnNestId } from "./gridDndUtils";
import type { TreeNodeData } from "@/features/tree/treeStore";

interface Props {
  folder: TreeNodeData;
  compact?: boolean;
  isDragOverlay?: boolean;
}

export function GridFolderCard({ folder, compact, isDragOverlay }: Props) {
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);
  const projectId = useTreeStore((s) => s.projectId);
  const setContainerId = useGridStore((s) => s.setContainerId);
  const expandedFolderIds = useGridStore((s) => s.expandedFolderIds);
  const toggleFolderExpanded = useGridStore((s) => s.toggleFolderExpanded);

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

  const isExpanded = expandedFolderIds.has(folder.id);

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
    toggleFolderExpanded(folder.id);
  }

  return (
    <div
      ref={(node) => {
        setNestRef(node);
        setDragRef(node);
      }}
      className={cn(
        "group relative flex flex-col rounded-md border-2 border-dashed border-border/60 bg-muted/30",
        "hover:border-primary/50 hover:bg-accent/40 transition-colors",
        "select-none",
        isNestOver && "border-primary bg-primary/10 ring-2 ring-primary",
        isDragging && "opacity-40",
      )}
      style={{ transition: "opacity 120ms ease-out" }}
    >
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
          onClick={diveIn}
          {...attributes}
          {...listeners}
          className="flex flex-1 items-center gap-1.5 min-w-0 text-left cursor-grab active:cursor-grabbing"
          title={t("grid.folderCard.diveIn", "クリックで中を表示")}
        >
          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate text-sm font-semibold">
            {folder.title}
          </span>
        </button>
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
              {t("grid.folderCard.scenes", "{{n}} シーン", { n: directScenes })}
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
    </div>
  );
}
