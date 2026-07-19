import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, CircleCheck, Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { HostedEditorEntryMode } from "./HostedEditorTrialBar";

interface HostedEditorHandoffDialogProps {
  open: boolean;
  entryMode: HostedEditorEntryMode;
  onClose: () => void;
  downloadHandoff: () => Promise<string>;
}

type HandoffDialogContentProps = Omit<HostedEditorHandoffDialogProps, "open">;

function HandoffDialogContent({
  entryMode,
  onClose,
  downloadHandoff,
}: HandoffDialogContentProps) {
  const { t } = useTranslation();
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadedFilename, setDownloadedFilename] = useState<string | null>(
    null,
  );
  const [downloadFailed, setDownloadFailed] = useState(false);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const handleDownload = useCallback(async () => {
    if (isDownloading) return;
    setDownloadFailed(false);
    setIsDownloading(true);

    try {
      const filename = (await downloadHandoff()).trim();
      if (!filename) throw new Error("Handoff download returned no filename");
      if (mountedRef.current) setDownloadedFilename(filename);
    } catch (error) {
      console.error("[hosted-editor] handoff download failed", error);
      if (mountedRef.current) {
        setDownloadedFilename(null);
        setDownloadFailed(true);
      }
    } finally {
      if (mountedRef.current) setIsDownloading(false);
    }
  }, [downloadHandoff, isDownloading]);

  const entryDescription =
    entryMode === "scan"
      ? t("hostedEditor.handoff.scanDescription")
      : t("hostedEditor.handoff.standaloneDescription");

  return (
    <DialogContent showClose={false} className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{t("hostedEditor.handoff.title")}</DialogTitle>
        <DialogDescription className="space-y-1">
          <span className="block">{entryDescription}</span>
          <span className="block">
            {t("hostedEditor.handoff.downloadInstruction")}
          </span>
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 text-sm">
        {downloadFailed && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive"
          >
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4" />
            <span>{t("hostedEditor.handoff.downloadFailed")}</span>
          </div>
        )}

        {downloadedFilename && (
          <div className="space-y-3" aria-live="polite">
            <div
              role="status"
              className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3"
            >
              <CircleCheck
                aria-hidden="true"
                className="mt-0.5 size-4 text-primary"
              />
              <span className="min-w-0 break-all">
                {t("hostedEditor.handoff.downloaded", {
                  filename: downloadedFilename,
                })}
              </span>
            </div>

            <Button asChild className="w-full">
              <a href="grimodex://handoff">
                <ExternalLink aria-hidden="true" />
                {t("hostedEditor.handoff.openGrimodex")}
              </a>
            </Button>

            <p className="text-xs text-muted-foreground">
              {t("hostedEditor.handoff.launchFallback")}
            </p>
          </div>
        )}
      </div>

      <DialogFooter className="flex-wrap">
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("common.close")}
        </Button>
        <Button
          type="button"
          variant={downloadedFilename ? "outline" : "default"}
          disabled={isDownloading}
          aria-busy={isDownloading}
          onClick={() => void handleDownload()}
        >
          <Download aria-hidden="true" />
          {isDownloading
            ? t("hostedEditor.handoff.downloading")
            : t("hostedEditor.handoff.download")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

export function HostedEditorHandoffDialog({
  open,
  entryMode,
  onClose,
  downloadHandoff,
}: HostedEditorHandoffDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      {open && (
        <HandoffDialogContent
          key={entryMode}
          entryMode={entryMode}
          onClose={onClose}
          downloadHandoff={downloadHandoff}
        />
      )}
    </Dialog>
  );
}
