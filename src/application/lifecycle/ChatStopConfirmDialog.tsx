import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import "./chatStopConfirmTranslations";
import type { ChatStopConfirmRequest } from "./chatStopConfirm";

/** 生成中の応答を中断して終了／切り替えるかの確認。閉じる操作は「断る」。 */
export default function ChatStopConfirmDialog({
  kind,
  answer,
}: ChatStopConfirmRequest) {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={(open) => !open && answer(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("chatStop.title")}</DialogTitle>
          <DialogDescription>
            {t(`chatStop.${kind}Description`)}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-end">
          <button
            type="button"
            onClick={() => answer(false)}
            className="rounded-md border border-input px-3 py-1.5 text-sm hover:bg-muted"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => answer(true)}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t(`chatStop.${kind}Confirm`)}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
