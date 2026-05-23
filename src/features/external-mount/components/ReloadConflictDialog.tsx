import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useExternalRootStore } from "../externalRootStore";
import { resolveReloadConflict } from "../mountManager";

export function ReloadConflictDialog() {
  const { t } = useTranslation();
  const conflict = useExternalRootStore((s) => s.conflicts[0]);
  const pendingCount = useExternalRootStore((s) => s.conflicts.length);

  return (
    <Dialog
      open={conflict != null}
      onOpenChange={(open) => {
        if (!open) useExternalRootStore.getState().shiftConflict();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("externalMount.conflictTitle")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("externalMount.conflictBody")}
        </p>
        {pendingCount > 1 && (
          <p className="text-xs text-muted-foreground">
            {t("externalMount.conflictQueue", { count: pendingCount - 1 })}
          </p>
        )}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-sm hover:bg-accent"
            onClick={() => void resolveReloadConflict("keep-local")}
          >
            {t("externalMount.keepLocal")}
          </button>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            onClick={() => void resolveReloadConflict("reload")}
          >
            {t("externalMount.reload")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
