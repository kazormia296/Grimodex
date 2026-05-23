import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { openFolderDialog } from "@/lib/dialog";
import { addExternalMount } from "../mountManager";

interface AddMountDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AddMountDialog({ open, onClose }: AddMountDialogProps) {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  async function pickFolder() {
    const picked = await openFolderDialog();
    if (picked) {
      setPath(picked);
      if (!label) {
        const parts = picked.replace(/\\/g, "/").split("/");
        setLabel(parts[parts.length - 1] ?? picked);
      }
    }
  }

  async function handleAdd() {
    if (!path.trim()) return;
    setBusy(true);
    try {
      await addExternalMount(path.trim(), label.trim() || undefined);
      onClose();
      setPath("");
      setLabel("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("externalMount.addTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="text-muted-foreground">
              {t("externalMount.path")}
            </span>
            <div className="mt-1 flex gap-2">
              <input
                className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={t("externalMount.pathPlaceholder")}
              />
              <button
                type="button"
                className="rounded border border-border px-3 py-1.5 text-sm hover:bg-accent"
                onClick={() => void pickFolder()}
              >
                {t("externalMount.browse")}
              </button>
            </div>
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">
              {t("externalMount.label")}
            </span>
            <input
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || !path.trim()}
            className="w-full rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            onClick={() => void handleAdd()}
          >
            {t("externalMount.mount")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
