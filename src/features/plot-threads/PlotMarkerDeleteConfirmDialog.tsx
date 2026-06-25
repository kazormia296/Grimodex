import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * branch/merge の起点（アンカー）になっているマーカーを削除するときの確認ダイアログ。
 * Scene パネルの削除確認（DeleteConfirmDialog）と同じ Dialog パターン。削除すると
 * 紐づく分岐 / 合流エッジも一緒に消えるため、その件数を提示して確認を取る。
 */
export function PlotMarkerDeleteConfirmDialog({
  edgeCount,
  onCancel,
  onConfirm,
}: {
  /** このマーカーを起点に消える分岐 / 合流エッジの件数。 */
  edgeCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle>
            {t("plotThread.deleteMarkerConfirmTitle", "マーカーの削除")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "plotThread.deleteMarkerConfirmBody",
              "このマーカーは分岐 / 合流の起点です。削除すると {{count}} 件の分岐 / 合流も削除されます。続行しますか？",
              { count: edgeCount },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" size="xs" onClick={onCancel}>
            {t("common.cancel", "キャンセル")}
          </Button>
          <Button
            type="button"
            variant="default"
            size="xs"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onConfirm}
          >
            {t("common.deleteConfirm", "削除する")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
