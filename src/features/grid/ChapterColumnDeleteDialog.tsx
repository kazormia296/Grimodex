import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Interpolated into deleteDescription as {{title}}. */
  folderTitle: string;
  /** Disables both footer buttons while the delete is in flight. */
  busy: boolean;
  onConfirm: () => void;
}

/**
 * Confirmation dialog for deleting a chapter column. Shared by the
 * `GridChapterColumnMenu` / `GridChapterColumnContextMenu` mirror pair.
 */
export function ChapterColumnDeleteDialog({
  open,
  onOpenChange,
  folderTitle,
  busy,
  onConfirm,
}: Props) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
              { title: folderTitle },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("common.cancel", "キャンセル")}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {t("common.delete", "削除")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
