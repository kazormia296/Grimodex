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
 * プロット（マーカー / スレッド）の削除確認ダイアログ。Scene パネルの削除確認
 * （DeleteConfirmDialog）と同じ Dialog パターン。削除すると紐づく分岐 / 合流やマーカーも
 * 一緒に消えるため、呼び出し側が件数を織り込んだ title / description を渡す。
 */
export function PlotMarkerDeleteConfirmDialog({
  title,
  description,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
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
