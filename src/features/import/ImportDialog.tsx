import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import type { ImportSource, MarkdownImportMode } from "./importTypes";
import { defaultImportTarget, type ImportTarget } from "./importTarget";
import { ImportTargetPanel } from "./importShared";
import { NovelcrafterImportFlow } from "./flows/NovelcrafterImportFlow";
import { KakuyomuImportFlow } from "./flows/KakuyomuImportFlow";
import { MarkdownImportFlow } from "./flows/MarkdownImportFlow";
import { NovelImportFlow } from "./flows/NovelImportFlow";
import { ScanImportFlow } from "./flows/ScanImportFlow";
import { ImportWizard } from "./wizard/ImportWizard";
import { GenericImportWizardPreview } from "./wizard/generic/GenericImportWizardPreview";

interface Props {
  open: boolean;
  onClose: () => void;
}

const SOURCES: ImportSource[] = [
  "novelcrafter",
  "kakuyomu",
  "markdown",
  "novel",
  "scan",
];

const DIALOG_PANEL_CLASS =
  "flex h-[min(480px,85vh)] w-[520px] flex-col gap-4 overflow-hidden p-6";

/**
 * インポート UI 本体（AnimatedOverlay を含まないコンテンツ部）。
 * 単体ダイアログ（ImportDialog）と統合ダイアログ（TransferDialog）の
 * 両方から再利用する。閉じる制御は呼び出し側の onClose に委譲する。
 */
export function ImportDialogBody({
  onClose,
  onBusyChange,
  onFailureChange,
}: {
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
  onFailureChange?: (failed: boolean) => void;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<ImportSource>("novelcrafter");
  const [markdownMode, setMarkdownMode] =
    useState<MarkdownImportMode>("single");
  const [importTarget, setImportTarget] = useState<ImportTarget>(() =>
    defaultImportTarget("novelcrafter"),
  );
  const [flowKey, setFlowKey] = useState(0);
  const [flowBusy, setFlowBusy] = useState(false);
  const [flowFailed, setFlowFailed] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [genericWizardOpen, setGenericWizardOpen] = useState(false);
  const interactionLocked = flowBusy || flowFailed;

  const handleBusyChange = useCallback(
    (busy: boolean) => {
      setFlowBusy(busy);
      onBusyChange?.(busy);
    },
    [onBusyChange],
  );

  const handleClose = useCallback(() => {
    if (flowBusy) return;
    setFlowFailed(false);
    onFailureChange?.(false);
    setFlowKey((k) => k + 1);
    onClose();
  }, [flowBusy, onClose, onFailureChange]);
  const handleImportComplete = useCallback(() => {
    setFlowFailed(false);
    onFailureChange?.(false);
    setFlowKey((k) => k + 1);
    onClose();
  }, [onClose, onFailureChange]);

  const handleFailureChange = useCallback(
    (failed: boolean) => {
      setFlowFailed(failed);
      onFailureChange?.(failed);
    },
    [onFailureChange],
  );

  const handleSourceChange = useCallback(
    (next: ImportSource) => {
      if (interactionLocked) return;
      handleFailureChange(false);
      setSource(next);
      setFlowKey((k) => k + 1);
    },
    [handleFailureChange, interactionLocked],
  );

  useEffect(() => {
    setImportTarget(
      defaultImportTarget(
        source,
        source === "markdown" ? markdownMode : undefined,
      ),
    );
  }, [source, markdownMode]);

  useEffect(() => {
    rootRef.current?.focus();
  }, [source]);

  const sourceLabel = (s: ImportSource): string => {
    switch (s) {
      case "novelcrafter":
        return t("import.source.novelcrafter");
      case "kakuyomu":
        return t("import.source.kakuyomu");
      case "markdown":
        return t("import.source.markdown");
      case "novel":
        return t("import.source.novel");
      case "scan":
        return t("import.source.scan");
    }
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col gap-4 outline-none"
    >
      <h2 id="import-dialog-title" className="shrink-0 text-base font-semibold">
        {t("import.dialogTitleUnified")}
      </h2>

      <div className="flex shrink-0 justify-end gap-2">
        <button
          type="button"
          data-testid="import-wizard-entry"
          disabled={interactionLocked}
          onClick={() => setWizardOpen(true)}
          className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          新インポート（プレビュー）
        </button>
        <button
          type="button"
          data-testid="import-generic-wizard-entry"
          disabled={interactionLocked}
          onClick={() => setGenericWizardOpen(true)}
          className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          Generic（プレビュー）
        </button>
      </div>

      {genericWizardOpen ? (
        <GenericImportWizardPreview
          onClose={() => {
            setGenericWizardOpen(false);
          }}
        />
      ) : wizardOpen ? (
        <ImportWizard
          onClose={() => {
            setWizardOpen(false);
          }}
        />
      ) : (
        <>
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
            disabled={interactionLocked}
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

      {source !== "scan" && (
        <ImportTargetPanel
          importTarget={importTarget}
          onImportTargetChange={setImportTarget}
          disabled={interactionLocked}
        />
      )}

      <div
        key={flowKey}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
      >
        {source === "novelcrafter" && (
          <NovelcrafterImportFlow
            importTarget={importTarget}
            onClose={handleClose}
            onBusyChange={handleBusyChange}
            onFailedChange={handleFailureChange}
          />
        )}
        {source === "kakuyomu" && (
          <KakuyomuImportFlow
            importTarget={importTarget}
            onClose={handleClose}
            onBusyChange={handleBusyChange}
            onFailedChange={handleFailureChange}
          />
        )}
        {source === "markdown" && (
          <MarkdownImportFlow
            importTarget={importTarget}
            markdownMode={markdownMode}
            onMarkdownModeChange={setMarkdownMode}
            onClose={handleClose}
            onBusyChange={handleBusyChange}
            onFailedChange={handleFailureChange}
          />
        )}
        {source === "novel" && (
          <NovelImportFlow
            importTarget={importTarget}
            onClose={handleClose}
            onBusyChange={handleBusyChange}
            onFailedChange={handleFailureChange}
          />
        )}
        {source === "scan" && (
          <ScanImportFlow
            onClose={handleClose}
            onComplete={handleImportComplete}
            onBusyChange={handleBusyChange}
          />
        )}
      </div>
        </>
      )}
    </div>
  );
}

export function ImportDialog({ open, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const handleClose = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  return (
    <AnimatedOverlay
      open={open}
      onClose={handleClose}
      className={`${DIALOG_PANEL_CLASS} rounded-lg border border-border bg-background shadow-xl outline-none`}
    >
      <ImportDialogBody onClose={onClose} onBusyChange={setBusy} />
    </AnimatedOverlay>
  );
}

/** @deprecated Use ImportDialog */
export { ImportDialog as NovelcrafterImportDialog };
