import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MarkdownDoc } from "@/features/settings/categories/about/MarkdownDoc";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useReleaseNotesStore } from "./releaseNotesStore";

export function ReleaseNotesDialog() {
  const { t } = useTranslation();
  const isOpen = useReleaseNotesStore((s) => s.isOpen);
  const version = useReleaseNotesStore((s) => s.version);
  const src = useReleaseNotesStore((s) => s.src);
  const isFallback = useReleaseNotesStore((s) => s.isFallback);
  const mode = useReleaseNotesStore((s) => s.mode);
  const close = useReleaseNotesStore((s) => s.close);
  const updateGlobalSettings = useWorkspaceStore((s) => s.updateGlobalSettings);

  const tryClose = useCallback(async () => {
    if (mode === "auto" && version != null) {
      const ok = await updateGlobalSettings({
        lastSeenReleaseNotesVersion: version,
      });
      if (!ok) {
        toast.error(t("common.saveFailed"));
        return;
      }
    }
    close();
  }, [mode, version, updateGlobalSettings, close, t]);

  if (!isOpen || version == null || src == null) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && void tryClose()}>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col gap-3">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>{t("releaseNotes.title", { version })}</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 max-h-[70vh] flex-1 flex-col gap-2 overflow-y-auto rounded border border-border px-4 py-3">
          {isFallback && (
            <p className="text-xs text-muted-foreground">
              {t("releaseNotes.fallbackLocale")}
            </p>
          )}
          <MarkdownDoc src={src} />
        </div>

        <DialogFooter className="flex-shrink-0">
          <Button type="button" onClick={() => void tryClose()}>
            {t("releaseNotes.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
