import { useTranslation } from "react-i18next";
import { FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useChapterColumnMenu } from "./useChapterColumnMenu";
import { ChapterColumnDeleteDialog } from "./ChapterColumnDeleteDialog";

interface Props {
  folderId: string;
  children: React.ReactNode;
}

/**
 * Right-click menu for chapter columns.
 *
 * Rename signals `useTreeStore.setPendingRenameId(folderId)` — the column
 * header watches that flag (via the existing `shouldAutoEdit` path) and
 * flips into inline edit. Delete stays behind a Dialog because deleting an
 * entire chapter (and all child scenes) deserves confirmation.
 */
export function GridChapterColumnContextMenu({ folderId, children }: Props) {
  const { t } = useTranslation();
  const {
    diveIn,
    addScene,
    requestRename,
    commitDelete,
    deleteOpen,
    setDeleteOpen,
    busy,
    folderTitle,
  } = useChapterColumnMenu(folderId);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-[180px]">
          <ContextMenuItem onSelect={diveIn}>
            <FolderOpen className="h-3.5 w-3.5" />
            {t("grid.column.contextMenu.diveIn", "中を表示")}
          </ContextMenuItem>

          <ContextMenuItem onSelect={() => void addScene().catch(() => {})}>
            <Plus className="h-3.5 w-3.5" />
            {t("grid.column.contextMenu.addScene", "シーンを追加")}
          </ContextMenuItem>

          <ContextMenuSeparator />

          <ContextMenuItem onSelect={requestRename}>
            <Pencil className="h-3.5 w-3.5" />
            {t("grid.column.contextMenu.rename", "リネーム")}
          </ContextMenuItem>

          <ContextMenuItem
            onSelect={() => setDeleteOpen(true)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("grid.column.contextMenu.delete", "削除")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <ChapterColumnDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        folderTitle={folderTitle}
        busy={busy}
        onConfirm={() => void commitDelete()}
      />
    </>
  );
}
