import { useDroppable } from "@dnd-kit/core";
import { Plus, Folder } from "lucide-react";
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
  /** 現在 dive-in している folder。column はこの folder の表現。 */
  folder: TreeNodeData;
  /** 直下の scene 群（同 folder の chapter sub-folder は除外） */
  scenes: TreeNodeData[];
  display: GridDisplaySettings;
  /** 兄弟の chapter folder 一覧（「既存の章にまとめる」メニュー用） */
  chapters: TreeNodeData[];
  visibility: Map<string, CardVisibility>;
  dropIndicator?: DropIndicator | null;
  columnDropIndicator?: ColumnDropIndicator | null;
  axisLockOffsets?: Map<string, number>;
  onRequestDeleteConfirm?: (sceneIds: string[]) => void;
  flatOrder?: string[];
  pinnedItemId?: string | null;
}

/**
 * Phase 4 後続: dive-in 中の folder の「直下シーン」列。folder 自身の表現。
 *
 * - 実線（=「これは正式な folder の表現」のサイン）
 * - folder.title と folder アイコンをヘッダーに表示
 * - outline は GridContainerOutline bar 側に集約するため、ここでは表示しない
 * - 「新規章フォルダに変換」は意味的に noisy なため出さない
 *   （直下シーンを folder で wrap しなおすのは dive-in 時の主要操作ではない）
 */
export function GridContainerSceneColumn({
  folder,
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
    id: columnEndId(folder.id),
    data: { kind: "column-end", folderId: folder.id },
  });

  const { setNodeRef: setEmptyRef, isOver: isEmptyOver } = useDroppable({
    id: columnEmptyId(folder.id),
    data: { kind: "column-empty", folderId: folder.id },
  });

  async function addScene() {
    await createNode({ nodeType: "scene", parentId: folder.id });
  }

  const colWidth = display.compactCards ? "w-56" : "w-80";

  const visibleScenes = scenes.filter(
    (s) => visibility.get(s.id)?.passesFilter !== false,
  );

  return (
    <GridLooseColumnContextMenu
      variant="container"
      containerId={folder.id}
      scenes={scenes}
      chapters={chapters}
    >
      <div
        className={cn(
          `flex flex-col h-full ${colWidth} shrink-0 rounded-lg border bg-muted/30`,
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-b">
          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span
            className="flex-1 truncate text-sm font-semibold"
            title={folder.title}
          >
            {folder.title}
          </span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {visibleScenes.length}
            {visibleScenes.length !== scenes.length && (
              <span className="opacity-50">/{scenes.length}</span>
            )}
          </span>

          <GridLooseColumnMenu
            variant="container"
            containerId={folder.id}
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
            testId={`grid-container-column-list-${folder.id}`}
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
