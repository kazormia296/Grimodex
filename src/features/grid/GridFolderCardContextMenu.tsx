import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderOpen,
  Pencil,
  Trash2,
} from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface Props {
  folderId: string;
  isEmpty: boolean;
  isExpanded: boolean;
  onOpen: () => void;
  onToggleCollapse: () => void;
  children: React.ReactNode;
}

/**
 * Right-click menu for folder (chapter) cards in the Grid panel.
 *
 * Rename signals `useTreeStore.setPendingRenameId(folderId)` — the folder card
 * watches that flag and flips into inline edit. This keeps rename feeling
 * weightless (one Enter to commit) and matches how Scenes-panel rename works.
 * Delete still uses a Dialog because confirmation has more weight than a
 * single shortcut.
 */
export function GridFolderCardContextMenu({
  folderId,
  isEmpty,
  isExpanded,
  onOpen,
  onToggleCollapse,
  children,
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
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-[180px]">
          <ContextMenuItem onSelect={onOpen}>
            <FolderOpen className="h-3.5 w-3.5" />
            {t("grid.folderCard.contextMenu.open", "中を表示")}
            <ChevronRight className="ml-auto h-3.5 w-3.5 opacity-50" />
          </ContextMenuItem>

          <ContextMenuItem onSelect={onToggleCollapse} disabled={isEmpty}>
            {isExpanded ? (
              <ChevronsDownUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronsUpDown className="h-3.5 w-3.5" />
            )}
            {isExpanded
              ? t("grid.folderCard.contextMenu.collapse", "折りたたむ")
              : t("grid.folderCard.contextMenu.expand", "展開")}
          </ContextMenuItem>

          <ContextMenuSeparator />

          <ContextMenuItem onSelect={requestRename}>
            <Pencil className="h-3.5 w-3.5" />
            {t("grid.folderCard.contextMenu.rename", "リネーム")}
          </ContextMenuItem>

          <ContextMenuItem
            onSelect={() => setDeleteOpen(true)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("grid.folderCard.contextMenu.delete", "削除")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

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
