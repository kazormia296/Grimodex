import { useTranslation } from "react-i18next";
import { FolderOpen, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChapterColumnMenu } from "./useChapterColumnMenu";
import { ChapterColumnDeleteDialog } from "./ChapterColumnDeleteDialog";

interface Props {
  folderId: string;
}

/**
 * Hover-revealed kebab for chapter columns. 1:1 mirror of
 * `GridChapterColumnContextMenu` (shared logic lives in
 * `useChapterColumnMenu`).
 */
export function GridChapterColumnMenu({ folderId }: Props) {
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-0 group-hover/colheader:opacity-100 data-[state=open]:opacity-100 transition-opacity"
            onClick={(e) => e.stopPropagation()}
            data-testid="grid-chapter-column-menu-btn"
            title={t("grid.column.menu", "メニュー")}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-[180px]"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenuItem onSelect={diveIn}>
            <FolderOpen className="h-3.5 w-3.5" />
            {t("grid.column.contextMenu.diveIn", "中を表示")}
          </DropdownMenuItem>

          <DropdownMenuItem onSelect={() => void addScene().catch(() => {})}>
            <Plus className="h-3.5 w-3.5" />
            {t("grid.column.contextMenu.addScene", "シーンを追加")}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={requestRename}>
            <Pencil className="h-3.5 w-3.5" />
            {t("grid.column.contextMenu.rename", "リネーム")}
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={() => setDeleteOpen(true)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("grid.column.contextMenu.delete", "削除")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
