import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGridStore } from "./gridStore";
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
}

/**
 * Hover-revealed kebab for chapter columns. 1:1 mirror of
 * `GridChapterColumnContextMenu`.
 */
export function GridChapterColumnMenu({ folderId }: Props) {
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

          <DropdownMenuItem onSelect={() => void addScene()}>
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
