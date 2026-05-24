import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import type { ImportSource, MarkdownImportMode } from "./importTypes";
import {
  defaultImportTarget,
  type ImportTarget,
} from "./importTarget";
import { ImportTargetPanel } from "./importShared";
import { NovelcrafterImportFlow } from "./flows/NovelcrafterImportFlow";
import { KakuyomuImportFlow } from "./flows/KakuyomuImportFlow";
import { MarkdownImportFlow } from "./flows/MarkdownImportFlow";

interface Props {
  open: boolean;
  onClose: () => void;
}

const SOURCES: ImportSource[] = ["novelcrafter", "kakuyomu", "markdown"];

const DIALOG_PANEL_CLASS =
  "flex h-[min(480px,85vh)] w-[520px] flex-col gap-4 overflow-hidden p-6";

export function ImportDialog({ open, onClose }: Props) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<ImportSource>("novelcrafter");
  const [markdownMode, setMarkdownMode] = useState<MarkdownImportMode>("single");
  const [importTarget, setImportTarget] = useState<ImportTarget>(() =>
    defaultImportTarget("novelcrafter"),
  );
  const [flowKey, setFlowKey] = useState(0);

  const handleClose = useCallback(() => {
    setFlowKey((k) => k + 1);
    onClose();
  }, [onClose]);

  const handleSourceChange = useCallback((next: ImportSource) => {
    setSource(next);
    setFlowKey((k) => k + 1);
  }, []);

  useEffect(() => {
    setImportTarget(
      defaultImportTarget(source, source === "markdown" ? markdownMode : undefined),
    );
  }, [source, markdownMode]);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open, source]);

  const sourceLabel = (s: ImportSource): string => {
    switch (s) {
      case "novelcrafter":
        return t("import.source.novelcrafter");
      case "kakuyomu":
        return t("import.source.kakuyomu");
      case "markdown":
        return t("import.source.markdown");
    }
  };

  return (
    <AnimatedOverlay
      open={open}
      onClose={handleClose}
      className={`${DIALOG_PANEL_CLASS} rounded-lg border border-border bg-background shadow-xl outline-none`}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-dialog-title"
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col gap-4"
      >
        <h2 id="import-dialog-title" className="shrink-0 text-base font-semibold">
          {t("import.dialogTitleUnified")}
        </h2>

        <div
          className="flex shrink-0 flex-wrap gap-1"
          role="tablist"
          aria-label={t("import.sourceLabel")}
        >
          {SOURCES.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={source === s}
              data-testid={`import-source-${s}`}
              onClick={() => handleSourceChange(s)}
              className={`rounded px-2 py-1 text-xs ${
                source === s
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent"
              }`}
            >
              {sourceLabel(s)}
            </button>
          ))}
        </div>

        <ImportTargetPanel
          importTarget={importTarget}
          onImportTargetChange={setImportTarget}
        />

        <div
          key={flowKey}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
        >
          {source === "novelcrafter" && (
            <NovelcrafterImportFlow
              importTarget={importTarget}
              onClose={handleClose}
            />
          )}
          {source === "kakuyomu" && (
            <KakuyomuImportFlow
              importTarget={importTarget}
              onClose={handleClose}
            />
          )}
          {source === "markdown" && (
            <MarkdownImportFlow
              importTarget={importTarget}
              markdownMode={markdownMode}
              onMarkdownModeChange={setMarkdownMode}
              onClose={handleClose}
            />
          )}
        </div>
      </div>
    </AnimatedOverlay>
  );
}

/** @deprecated Use ImportDialog */
export { ImportDialog as NovelcrafterImportDialog };
