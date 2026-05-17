import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  folderId: string;
  isEmpty: boolean;
  isExpanded: boolean;
  onOpen: () => void;
  onToggleCollapse: () => void;
}

/**
 * Hover-revealed kebab for folder cards. Items mirror
 * `GridFolderCardContextMenu` 1:1 — kebab gives discoverability ("there are
 * actions here"), right-click gives the power-user shortcut. Both surfaces
 * keep the same source-of-truth labels.
 */
export function GridFolderMenu({
  folderId,
  isEmpty,
  isExpanded,
  onOpen,
  onToggleCollapse,
}: Props) {
  const { t } = useTranslation();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const folder = useTreeStore((s) => s.nodes.find((n) => n.id === folderId));

  function requestRename() {
    useTreeStore.getState().setPendingRenameId(folderId);
  }

  async function commitDelete() {
    if (busy) return;
    setBusy(true);
    try {
      await useTreeStore.getState().deleteNode(folderId);
      setDeleteOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity"
            onClick={(e) => e.stopPropagation()}
            data-testid="grid-folder-menu-btn"
            title={t("grid.folderCard.menu", "メニュー")}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-[160px]"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenuItem onSelect={onOpen}>
            <FolderOpen className="h-3.5 w-3.5" />
            {t("grid.folderCard.contextMenu.open", "中を表示")}
          </DropdownMenuItem>

          <DropdownMenuItem onSelect={onToggleCollapse} disabled={isEmpty}>
            {isExpanded ? (
              <ChevronsDownUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronsUpDown className="h-3.5 w-3.5" />
            )}
            {isExpanded
              ? t("grid.folderCard.contextMenu.collapse", "折りたたむ")
              : t("grid.folderCard.contextMenu.expand", "展開")}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={requestRename}>
            <Pencil className="h-3.5 w-3.5" />
            {t("grid.folderCard.contextMenu.rename", "リネーム")}
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={() => setDeleteOpen(true)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("grid.folderCard.contextMenu.delete", "削除")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent
          className="max-w-sm"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>
              {t("grid.folderCard.dialog.deleteTitle", "フォルダを削除")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "grid.folderCard.dialog.deleteDescription",
                "「{{title}}」と配下のすべてのシーンを削除します。元に戻せません。",
                { title: folder?.title ?? "" },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteOpen(false)}
              disabled={busy}
            >
              {t("common.cancel", "キャンセル")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void commitDelete()}
              disabled={busy}
            >
              {t("common.delete", "削除")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
