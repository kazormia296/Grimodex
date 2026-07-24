import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { ImportTargetPanel } from "./importShared";
import { defaultImportTarget, type ImportTarget } from "./importTarget";
import type { ImportSource, MarkdownImportMode } from "./importTypes";
import { NovelcrafterImportFlow } from "./flows/NovelcrafterImportFlow";
import { KakuyomuImportFlow } from "./flows/KakuyomuImportFlow";
import { MarkdownImportFlow } from "./flows/MarkdownImportFlow";
import { NovelImportFlow } from "./flows/NovelImportFlow";
import { cn } from "@/lib/utils";
import { useWorkspaceViewportProfile } from "@/runtime/workspaceViewportContext";

type WebEditorImportSource = Exclude<ImportSource, "scan">;

const WEB_EDITOR_IMPORT_SOURCES: WebEditorImportSource[] = [
  "novelcrafter",
  "kakuyomu",
  "markdown",
  "novel",
];

interface WebEditorImportDialogProps {
  open: boolean;
  onClose: () => void;
}

export function WebEditorImportDialog({
  open,
  onClose,
}: WebEditorImportDialogProps) {
  const { t } = useTranslation();
  const phoneWorkspace = useWorkspaceViewportProfile() === "phone";
  const rootRef = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<WebEditorImportSource>("novelcrafter");
  const [markdownMode, setMarkdownMode] =
    useState<MarkdownImportMode>("single");
  const [importTarget, setImportTarget] = useState<ImportTarget>(() =>
    defaultImportTarget("novelcrafter"),
  );
  const [flowKey, setFlowKey] = useState(0);
  const [flowBusy, setFlowBusy] = useState(false);
  const [flowFailed, setFlowFailed] = useState(false);
  const interactionLocked = flowBusy || flowFailed;

  useEffect(() => {
    setImportTarget(
      defaultImportTarget(
        source,
        source === "markdown" ? markdownMode : undefined,
      ),
    );
  }, [source, markdownMode]);

  useEffect(() => {
    if (open) rootRef.current?.focus();
  }, [open, source]);

  const handleClose = useCallback(() => {
    if (flowBusy) return;
    setFlowFailed(false);
    setFlowKey((key) => key + 1);
    onClose();
  }, [flowBusy, onClose]);

  const selectSource = useCallback(
    (next: WebEditorImportSource) => {
      if (interactionLocked) return;
      setFlowFailed(false);
      setSource(next);
      setFlowKey((key) => key + 1);
    },
    [interactionLocked],
  );

  return (
    <AnimatedOverlay
      open={open}
      onClose={handleClose}
      testId="web-editor-import-dialog"
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden border border-border bg-background shadow-xl outline-none",
        phoneWorkspace
          ? "h-[var(--visual-viewport-height,100dvh)] w-screen max-h-none max-w-none gap-3 rounded-none border-0 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
          : "h-[min(560px,85vh)] w-[680px] max-w-[92vw] gap-4 rounded-lg p-6",
      )}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("import.dialogTitleUnified")}
        tabIndex={-1}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none",
          phoneWorkspace ? "gap-3" : "gap-4",
        )}
      >
        <button
          type="button"
          onClick={handleClose}
          disabled={flowBusy}
          aria-label={t("common.close")}
          className={cn(
            "absolute right-0 top-0 z-10 rounded text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
            phoneWorkspace
              ? "flex min-h-11 min-w-11 items-center justify-center"
              : "p-1",
          )}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>

        <div
          className={cn("min-w-0 shrink-0", phoneWorkspace ? "pr-12" : "pr-8")}
        >
          <h2 className="break-words text-base font-semibold">
            {t("import.dialogTitleUnified")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("hostedEditor.import.localOnlyNotice")}
          </p>
        </div>

        <div
          className="flex min-w-0 max-w-full shrink-0 flex-wrap gap-1 overflow-x-hidden"
          role="tablist"
          aria-label={t("import.sourceLabel")}
        >
          {WEB_EDITOR_IMPORT_SOURCES.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={source === item}
              data-testid={`import-source-${item}`}
              onClick={() => selectSource(item)}
              disabled={interactionLocked}
              className={cn(
                "max-w-full rounded px-2 py-1 text-xs",
                phoneWorkspace && "min-h-11 break-words",
                source === item
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent",
              )}
            >
              {t(`import.source.${item}`)}
            </button>
          ))}
        </div>

        <ImportTargetPanel
          importTarget={importTarget}
          onImportTargetChange={setImportTarget}
          disabled={interactionLocked}
        />

        <div
          key={flowKey}
          data-testid="web-editor-import-flow"
          className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-contain"
        >
          {source === "novelcrafter" && (
            <NovelcrafterImportFlow
              importTarget={importTarget}
              onClose={handleClose}
              enforceBrowserLimits
              onBusyChange={setFlowBusy}
              onFailedChange={setFlowFailed}
            />
          )}
          {source === "kakuyomu" && (
            <KakuyomuImportFlow
              importTarget={importTarget}
              onClose={handleClose}
              enforceBrowserLimits
              onBusyChange={setFlowBusy}
              onFailedChange={setFlowFailed}
            />
          )}
          {source === "markdown" && (
            <MarkdownImportFlow
              importTarget={importTarget}
              markdownMode={markdownMode}
              onMarkdownModeChange={(mode) => {
                if (!interactionLocked) setMarkdownMode(mode);
              }}
              onClose={handleClose}
              allowNativeFolderPicker={false}
              enforceBrowserLimits
              onBusyChange={setFlowBusy}
              onFailedChange={setFlowFailed}
            />
          )}
          {source === "novel" && (
            <NovelImportFlow
              importTarget={importTarget}
              onClose={handleClose}
              enforceBrowserLimits
              onBusyChange={setFlowBusy}
              onFailedChange={setFlowFailed}
            />
          )}
        </div>
      </div>
    </AnimatedOverlay>
  );
}

// Vite replaces the desktop TransferDialog module with this import-only module.
export { WebEditorImportDialog as TransferDialog };
