import { useEffect, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { Plus, MoreVertical, Folder } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cn } from "@/lib/utils";
import { GridSceneCard } from "./GridSceneCard";
import { consolidateLooseIntoChapter } from "./looseBatchOps";
import { columnEndId, columnEmptyId } from "./gridDndUtils";
import type { DropIndicator } from "./gridDndUtils";
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
  onRequestDeleteConfirm?: (sceneIds: string[]) => void;
  flatOrder?: string[];
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
  onRequestDeleteConfirm,
  flatOrder,
}: Props) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const createNode = useTreeStore((s) => s.createNode);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current &&
        !menuBtnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen]);

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

  async function handleConsolidate(chapterId: string) {
    setMenuOpen(false);
    await consolidateLooseIntoChapter(
      scenes.map((s) => s.id),
      chapterId,
    );
  }

  const colWidth = display.compactCards ? "w-56" : "w-80";

  const visibleScenes = scenes.filter(
    (s) => visibility.get(s.id)?.passesFilter !== false,
  );

  return (
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

        {scenes.length > 0 && chapters.length > 0 && (
          <div className="relative">
            <button
              ref={menuBtnRef}
              className="rounded p-0.5 hover:bg-accent transition-colors"
              onClick={() => setMenuOpen((v) => !v)}
              title={t("grid.looseColumn.menu", "操作")}
            >
              <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />
            </button>

            {menuOpen && (
              <div
                ref={menuRef}
                className="absolute right-0 top-full z-50 mt-1 min-w-[200px] rounded-md border bg-popover p-1 shadow-md text-sm"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="px-2 py-1 text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                  {t("grid.looseColumn.consolidate", "既存の章にまとめる")}
                </div>
                {chapters.map((ch) => (
                  <button
                    key={ch.id}
                    className="flex w-full items-center rounded px-2 py-1.5 hover:bg-accent text-[12px]"
                    onClick={() => void handleConsolidate(ch.id)}
                  >
                    {ch.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Cards */}
      <div className="flex flex-col gap-2 p-2 flex-1 min-h-0 overflow-y-auto">
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
                  dropIndicator={dropIndicator}
                  onRequestDeleteConfirm={onRequestDeleteConfirm}
                  flatOrder={flatOrder}
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
