import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { CodexEntryPhase } from "../phaseApi";
import { usePhaseStore } from "../phaseStore";
import { SceneSelector } from "./SceneSelector";

interface PhaseDialogProps {
  entryId: string;
  phase?: CodexEntryPhase | null;
  onClose: () => void;
  /** 新規作成時のContent初期値（直前フェーズ or ベースコンテンツ） */
  currentContent?: string;
}

export function PhaseDialog({
  entryId,
  phase,
  onClose,
  currentContent,
}: PhaseDialogProps) {
  const { t } = useTranslation();
  const createPhase = usePhaseStore((s) => s.createPhase);
  const updatePhase = usePhaseStore((s) => s.updatePhase);

  const isEditing = phase != null;

  const [label, setLabel] = useState(phase?.label ?? "");
  const [anchorNodeId, setAnchorNodeId] = useState<string | null>(
    phase?.anchorNodeId ?? null,
  );

  // Override fields: チェックで有効化
  const [summaryEnabled, setSummaryEnabled] = useState(
    phase?.summaryOverride != null,
  );
  const [summaryValue, setSummaryValue] = useState(
    phase?.summaryOverride ?? "",
  );
  const [contentEnabled, setContentEnabled] = useState(
    phase?.contentOverride != null,
  );
  const [contextModeEnabled, setContextModeEnabled] = useState(
    phase?.contextModeOverride != null,
  );
  const [contextModeValue, setContextModeValue] = useState(
    phase?.contextModeOverride ?? "mentioned",
  );

  const [isSubmitting, setIsSubmitting] = useState(false);

  const hasOverride = summaryEnabled || contentEnabled || contextModeEnabled;
  const canSubmit = label.trim() && anchorNodeId && hasOverride;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      const data = {
        label: label.trim(),
        anchorNodeId,
        summaryOverride: summaryEnabled ? summaryValue.trim() || "" : null,
        contentOverride: contentEnabled
          ? (phase?.contentOverride ?? currentContent ?? null)
          : null,
        contextModeOverride: contextModeEnabled ? contextModeValue : null,
      };
      if (isEditing) {
        await updatePhase(phase.id, data);
      } else {
        await createPhase({ entryId, ...data });
      }
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[420px] rounded-lg border border-border bg-background shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">
            {isEditing ? t("phase.editTitle") : t("phase.addTitle")}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          {/* Label */}
          <div>
            <label className="mb-1 block text-xs font-medium">
              {t("phase.labelField")}{" "}
              <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              placeholder={t("phase.labelPlaceholder")}
              autoFocus
            />
          </div>

          {/* Anchor scene */}
          <div>
            <label className="mb-1 block text-xs font-medium">
              {t("phase.anchorScene")}{" "}
              <span className="text-destructive">*</span>
            </label>
            <SceneSelector value={anchorNodeId} onChange={setAnchorNodeId} />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("phase.anchorSceneDesc")}
            </p>
          </div>

          {/* Override fields */}
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              ─── {t("phase.overrideFields")} ───
            </p>
            <div className="space-y-3">
              {/* Summary */}
              <div>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={summaryEnabled}
                    onChange={(e) => setSummaryEnabled(e.target.checked)}
                    className="h-3.5 w-3.5 rounded accent-primary"
                  />
                  <span className="text-xs font-medium">
                    {t("phase.summary")}
                  </span>
                </label>
                {summaryEnabled && (
                  <textarea
                    value={summaryValue}
                    onChange={(e) => setSummaryValue(e.target.value)}
                    rows={2}
                    className="mt-1.5 w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                    placeholder={t("phase.summaryPlaceholder")}
                  />
                )}
              </div>

              {/* Content */}
              <div>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={contentEnabled}
                    onChange={(e) => setContentEnabled(e.target.checked)}
                    className="h-3.5 w-3.5 rounded accent-primary"
                  />
                  <span className="text-xs font-medium">
                    {t("phase.content")}
                  </span>
                </label>
                {contentEnabled && (
                  <p className="mt-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
                    {t("phase.contentNote")}
                  </p>
                )}
              </div>

              {/* Context mode */}
              <div>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={contextModeEnabled}
                    onChange={(e) => setContextModeEnabled(e.target.checked)}
                    className="h-3.5 w-3.5 rounded accent-primary"
                  />
                  <span className="text-xs font-medium">
                    {t("phase.contextMode")}
                  </span>
                </label>
                {contextModeEnabled && (
                  <select
                    value={contextModeValue}
                    onChange={(e) => setContextModeValue(e.target.value)}
                    className="mt-1.5 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  >
                    <option value="always">always</option>
                    <option value="mentioned">mentioned</option>
                    <option value="suppress">suppress</option>
                    <option value="hidden">hidden</option>
                  </select>
                )}
              </div>
            </div>

            {!hasOverride && (
              <p className="mt-2 text-[11px] text-destructive">
                {t("phase.overrideRequired")}
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit || isSubmitting}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isSubmitting ? t("phase.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
