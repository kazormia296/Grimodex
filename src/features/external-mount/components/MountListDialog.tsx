import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useExternalRootStore } from "../externalRootStore";
import { removeExternalMount } from "../mountManager";
import { AddMountDialog } from "./AddMountDialog";

interface MountListDialogProps {
  open: boolean;
  onClose: () => void;
}

export function MountListDialog({ open, onClose }: MountListDialogProps) {
  const { t } = useTranslation();
  const roots = useExternalRootStore((s) => s.roots);
  const missingRoots = useExternalRootStore((s) => s.missingRoots);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("externalMount.title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("externalMount.description")}
          </p>
          <ul className="space-y-2">
            {roots.map((root) => (
              <li
                key={root.id}
                className="flex items-center gap-2 rounded border border-border px-3 py-2 text-sm"
              >
                <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{root.label}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {root.path}
                  </div>
                </div>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                  aria-label={t("externalMount.remove")}
                  onClick={() => void removeExternalMount(root.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
            {roots.length === 0 && (
              <li className="text-sm text-muted-foreground py-4 text-center">
                {t("externalMount.empty")}
              </li>
            )}
          </ul>
          {missingRoots.length > 0 && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
              {t("externalMount.missing")}
            </div>
          )}
          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 rounded border border-dashed border-border py-2 text-sm hover:bg-accent"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="h-4 w-4" />
            {t("externalMount.add")}
          </button>
        </DialogContent>
      </Dialog>
      <AddMountDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </>
  );
}
