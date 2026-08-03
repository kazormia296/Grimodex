import { useDroppable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cn } from "@/lib/utils";
import { GridSceneCard } from "./GridSceneCard";
import { GridLooseColumnContextMenu } from "./GridLooseColumnContextMenu";
import { GridLooseColumnMenu } from "./GridLooseColumnMenu";
import { GridVirtualList } from "./GridVirtualList";
import { columnEndId, columnEmptyId } from "./gridDndUtils";
import type { DropIndicator, ColumnDropIndicator } from "./gridDndUtils";
import type { GridDisplaySettings } from "./gridStore";

interface CardVisibility {
  matchesSearch: boolean;
  passesFilter: boolean;
}

interface Props {
  containerId: string | null;
  scenes: TreeNodeData[];
  display: GridDisplaySettings;
  chapters: TreeNodeData[];
  visibility: Map<string, CardVisibility>;
  dropIndicator?: DropIndicator | null;
  columnDropIndicator?: ColumnDropIndicator | null;
  axisLockOffsets?: Map<string, number>;
  onRequestDeleteConfirm?: (sceneIds: string[]) => void;
  /** Flat scene order across all columns, for range selection. */
  flatOrder?: string[];
  pinnedItemId?: string | null;
}

/**
 * Phase 4 後続: project root に直置きされた orphan シーンの列。
 * containerId が folder の場合は `GridContainerSceneColumn` を使うこと
 * （container の表現としての folder 列はこの component の責務外）。
 */
export function GridLooseColumn({
  containerId,
  scenes,
  display,
  chapters,
  visibility,
  dropIndicator,
  columnDropIndicator,
  axisLockOffsets,
  onRequestDeleteConfirm,
  flatOrder,
  pinnedItemId,
}: Props) {
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

  const colWidth = display.compactCards ? "w-56" : "w-80";

  const visibleScenes = scenes.filter(
    (s) => visibility.get(s.id)?.passesFilter !== false,
  );

  return (
    <GridLooseColumnContextMenu
      variant="loose"
      containerId={containerId}
      scenes={scenes}
      chapters={chapters}
    >
      <div
        className={cn(
          `flex flex-col h-full ${colWidth} shrink-0 rounded-lg border border-dashed bg-muted/10`,
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-1 px-3 py-2 border-b">
          <span className="flex-1 text-sm font-semibold text-muted-foreground">
            {t("grid.looseColumn.title", "未分類シーン")}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {visibleScenes.length}
            {visibleScenes.length !== scenes.length && (
              <span className="opacity-50">/{scenes.length}</span>
            )}
          </span>

          <GridLooseColumnMenu
            variant="loose"
            containerId={containerId}
            scenes={scenes}
            chapters={chapters}
          />
        </div>

        {/* Cards */}
        {scenes.length === 0 ? (
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
            items={visibleScenes}
            pinnedItemId={pinnedItemId}
            compact={display.compactCards}
            endRef={setEndRef}
            endClassName={cn(
              "rounded transition-colors",
              isEndOver && "bg-primary/20",
            )}
            testId="grid-loose-column-list"
            renderItem={(scene) => {
              const vis = visibility.get(scene.id);
              const isDropBefore =
                (dropIndicator?.targetId === scene.id &&
                  dropIndicator.position === "before") ||
                (columnDropIndicator?.targetId === scene.id &&
                  columnDropIndicator.position === "before");
              const isDropAfter =
                (dropIndicator?.targetId === scene.id &&
                  dropIndicator.position === "after") ||
                (columnDropIndicator?.targetId === scene.id &&
                  columnDropIndicator.position === "after");
              return (
                <GridSceneCard
                  scene={scene}
                  display={display}
                  dimmed={vis !== undefined && !vis.matchesSearch}
                  isDropBefore={isDropBefore}
                  isDropAfter={isDropAfter}
                  axisLockOffsetPx={axisLockOffsets?.get(scene.id)}
                  onRequestDeleteConfirm={onRequestDeleteConfirm}
                  flatOrder={flatOrder}
                />
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
    </GridLooseColumnContextMenu>
  );
}
