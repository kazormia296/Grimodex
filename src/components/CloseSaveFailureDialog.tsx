import { useTranslation } from "react-i18next";
import { ResponsiveAlertDialog } from "@/components/ui/responsive-alert-dialog";

export interface CloseSaveFailureDialogProps {
  open: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onExport: () => void;
  onDiscard: () => void;
}

export function CloseSaveFailureDialog({
  open,
  onCancel,
  onRetry,
  onExport,
  onDiscard,
}: CloseSaveFailureDialogProps) {
  const { t } = useTranslation();
  return (
    <ResponsiveAlertDialog
      open={open}
      onClose={onCancel}
      title={t("closeSaveFailure.title")}
      description={t("closeSaveFailure.description")}
      testId="close-save-failure-dialog"
    >
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-2 text-sm text-muted-foreground hover:bg-accent"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={onExport}
          className="rounded border border-border px-3 py-2 text-sm hover:bg-accent"
        >
          {t("closeSaveFailure.export")}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="rounded px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
        >
          {t("closeSaveFailure.discard")}
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90"
        >
          {t("closeSaveFailure.retry")}
        </button>
      </div>
    </ResponsiveAlertDialog>
  );
}
