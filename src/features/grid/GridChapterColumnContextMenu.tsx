import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGridStore } from "./gridStore";
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const folder = useTreeStore((s) => s.nodes.find((n) => n.id === folderId));
  const projectId = useTreeStore((s) => s.projectId);
  const createNode = useTreeStore((s) => s.createNode);
  const setContainerId = useGridStore((s) => s.setContainerId);

  function diveIn() {
    void setContainerId(projectId, folderId);
  }

  async function addScene() {
    await createNode({ nodeType: "scene", parentId: folderId });
  }

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

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent
          className="max-w-sm"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>
              {t("grid.column.dialog.deleteTitle", "章を削除")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "grid.column.dialog.deleteDescription",
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
