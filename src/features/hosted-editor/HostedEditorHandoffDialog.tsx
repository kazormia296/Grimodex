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
import { cn } from "@/lib/utils";
import { useWorkspaceViewportProfile } from "@/runtime/workspaceViewportContext";
interface HostedEditorHandoffDialogProps {
  open: boolean;
  onClose: () => void;
  downloadHandoff: () => Promise<string>;
}

type HandoffDialogContentProps = Omit<HostedEditorHandoffDialogProps, "open">;

function HandoffDialogContent({
  onClose,
  downloadHandoff,
}: HandoffDialogContentProps) {
  const { t } = useTranslation();
  const phoneWorkspace = useWorkspaceViewportProfile() === "phone";
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

  return (
    <DialogContent
      showClose={false}
      className={cn(
        "max-w-xl",
        phoneWorkspace &&
          "h-[var(--visual-viewport-height,100dvh)] w-screen max-h-none max-w-none content-start overflow-y-auto rounded-none border-0 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]",
      )}
    >
      <DialogHeader>
        <DialogTitle>{t("hostedEditor.handoff.title")}</DialogTitle>
        <DialogDescription className="space-y-1">
          <span className="block">{t("hostedEditor.handoff.description")}</span>
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

            <Button
              asChild
              className={cn("w-full", phoneWorkspace && "min-h-11")}
            >
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

      <DialogFooter
        className={cn("flex-wrap", phoneWorkspace && "grid grid-cols-1")}
      >
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          className={cn(phoneWorkspace && "min-h-11 w-full")}
        >
          {t("common.close")}
        </Button>
        <Button
          type="button"
          variant={downloadedFilename ? "outline" : "default"}
          disabled={isDownloading}
          aria-busy={isDownloading}
          onClick={() => void handleDownload()}
          className={cn(phoneWorkspace && "min-h-11 w-full")}
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
  onClose,
  downloadHandoff,
}: HostedEditorHandoffDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      {open && (
        <HandoffDialogContent
          onClose={onClose}
          downloadHandoff={downloadHandoff}
        />
      )}
    </Dialog>
  );
}
