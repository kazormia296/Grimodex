import { Folder, ChevronRight } from "lucide-react";
import { useDroppable } from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGridStore } from "./gridStore";
import { cn } from "@/lib/utils";
import { columnNestId } from "./gridDndUtils";
import type { TreeNodeData } from "@/features/tree/treeStore";

interface Props {
  folder: TreeNodeData;
  compact?: boolean;
}

export function GridFolderCard({ folder, compact }: Props) {
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);
  const projectId = useTreeStore((s) => s.projectId);
  const setContainerId = useGridStore((s) => s.setContainerId);

  const { setNodeRef: setNestRef, isOver: isNestOver } = useDroppable({
    id: columnNestId(folder.id),
    data: { kind: "column-nest", folderId: folder.id },
  });

  const directScenes = nodes.filter(
    (n) => n.parentId === folder.id && n.nodeType === "scene",
  ).length;
  const directFolders = nodes.filter(
    (n) => n.parentId === folder.id && n.nodeType === "folder",
  ).length;

  function diveIn() {
    void setContainerId(projectId, folder.id);
  }

  return (
    <button
      ref={setNestRef}
      type="button"
      onClick={diveIn}
      className={cn(
        "group relative flex flex-col rounded-md border-2 border-dashed border-border/60 bg-muted/30",
        "hover:border-primary/50 hover:bg-accent/40 transition-colors text-left",
        "select-none",
        isNestOver && "border-primary bg-primary/10 ring-2 ring-primary",
      )}
      title={t("grid.folderCard.diveIn", "クリックで中を表示")}
    >
      <div
        className={cn(
          "flex items-center gap-1.5",
          compact ? "px-2 py-1.5" : "px-3 py-2",
        )}
      >
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-semibold">
          {folder.title}
        </span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 group-hover:text-foreground" />
      </div>
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
        {directScenes === 0 && directFolders === 0 && (
          <span className="italic">{t("grid.folderCard.empty", "空")}</span>
        )}
      </div>
    </button>
  );
}
