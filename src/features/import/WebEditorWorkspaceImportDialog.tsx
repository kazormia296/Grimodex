import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { importWebEditorWorkspaceHandoff } from "@/features/import/webEditorWorkspaceImport";

interface WebEditorWorkspaceImportDialogProps {
  open: boolean;
  onClose: () => void;
}

export function WebEditorWorkspaceImportDialog({
  open,
  onClose,
}: WebEditorWorkspaceImportDialogProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !busy) onClose();
  };

  const handleImport = async () => {
    if (busy) return;

    setBusy(true);
    setError(null);
    try {
      const result = await importWebEditorWorkspaceHandoff();
      if (result.status === "imported") onClose();
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : t("hostedEditor.desktopImport.unknownError");
      setError(t("hostedEditor.desktopImport.failed", { error: message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showClose={!busy}>
        <DialogHeader>
          <DialogTitle>{t("hostedEditor.desktopImport.title")}</DialogTitle>
          <DialogDescription>
            {t("hostedEditor.desktopImport.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-3 rounded-md border border-border bg-muted/40 p-3 text-sm">
          <FileDown
            className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <p>{t("hostedEditor.desktopImport.fileNotice")}</p>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void handleImport()} disabled={busy}>
            {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            {busy
              ? t("hostedEditor.desktopImport.importing")
              : t("hostedEditor.desktopImport.selectFile")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
