import { useDroppable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cn } from "@/lib/utils";
import { GridSceneCard } from "./GridSceneCard";
import { columnEndId, columnEmptyId } from "./gridDndUtils";
import type { GridDisplaySettings } from "./gridStore";

interface Props {
  containerId: string | null;
  scenes: TreeNodeData[];
  display: GridDisplaySettings;
}

export function GridLooseColumn({ containerId, scenes, display }: Props) {
  const { t } = useTranslation();
  const createNode = useTreeStore((s) => s.createNode);

  const { setNodeRef: setEndRef, isOver: isEndOver } = useDroppable({
    id: columnEndId("loose"),
    data: { kind: "column-end", folderId: "loose" },
  });

  const { setNodeRef: setEmptyRef, isOver: isEmptyOver } = useDroppable({
    id: columnEmptyId("loose"),
    data: { kind: "column-empty", folderId: "loose" },
  });

  async function addScene() {
    await createNode({ nodeType: "scene", parentId: containerId });
  }

  return (
    <div className="flex flex-col w-56 shrink-0 rounded-lg border border-dashed bg-muted/10">
      {/* Header */}
      <div className="flex items-center gap-1 px-3 py-2 border-b">
        <span className="flex-1 text-sm font-semibold text-muted-foreground">
          {t("grid.looseColumn.title", "未分類シーン")}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {scenes.length}
        </span>
      </div>

      {/* Cards */}
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
            {scenes.map((scene) => (
              <GridSceneCard key={scene.id} scene={scene} display={display} />
            ))}
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
