import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Save, Trash2, AlertTriangle, ChevronRight } from "lucide-react";
import type { ExportSettings } from "./types";
import { DEFAULT_EXPORT_SETTINGS } from "./types";
import {
  detectExportPreset,
  settingsMatch,
  validateUserPresetName,
} from "./exportPresets";
import { getSiteEntry } from "./rubyProfiles";
import { ExportSitePickerDialog } from "./ExportSitePickerDialog";
import {
  addUserPreset,
  findUserPreset,
  removeUserPreset,
  type UserExportPreset,
} from "./exportUserPresets";
import type { RubyLengthWarning } from "./exportValidation";

// ────────────────────────────────────────────────────────────────────
// 保存ダイアログ
// ────────────────────────────────────────────────────────────────────

function SavePresetDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
      // ダイアログ初開時のみフォーカス。autoFocus は a11y 上推奨されない。
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // 親 ExportDialog (AnimatedOverlay) も Escape で onClose() するので、
  // capture phase で先取りして親まで伝播させない。
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [open, onClose]);

  if (!open) return null;

  function handleSave() {
    const result = validateUserPresetName(name);
    if (!result.ok) {
      setError(
        t(
          result.reason === "empty"
            ? "export.settings.userPresets.emptyError"
            : "export.settings.userPresets.tooLongError",
        ),
      );
      return;
    }
    onSave(name);
    onClose();
  }

  // ExportDialog (AnimatedOverlay) の内側 motion.div は scale animation で transform を持つため、
  // 子の position:fixed の包含ブロックがその内側に閉じ込められる。createPortal で document.body
  // に出すことで viewport 基準に戻す + ExportDialog より確実に上に重ねる。
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[320px] rounded-lg border border-border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-sm font-semibold">
          {t("export.settings.userPresets.saveTitle")}
        </h3>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          placeholder={t("export.settings.userPresets.namePlaceholder")}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") onClose();
          }}
        />
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-3 py-1 text-xs hover:bg-accent"
          >
            {t("export.settings.userPresets.cancel")}
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
          >
            {t("export.settings.userPresets.save")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ────────────────────────────────────────────────────────────────────
// 警告バナー
// ────────────────────────────────────────────────────────────────────

const MAX_DISPLAYED_WARNINGS = 5;

function WarningBanner({
  warnings,
  siteLabel,
}: {
  warnings: RubyLengthWarning[];
  siteLabel: string;
}) {
  const { t } = useTranslation();
  if (warnings.length === 0) return null;
  const shown = warnings.slice(0, MAX_DISPLAYED_WARNINGS);
  const rest = warnings.length - shown.length;
  return (
    <div className="my-2 rounded border border-yellow-500/40 bg-yellow-500/10 p-2 text-xs">
      <div className="mb-1 flex items-center gap-1 font-medium text-yellow-700 dark:text-yellow-400">
        <AlertTriangle className="h-3.5 w-3.5" />
        {t("export.settings.validation.title", { site: siteLabel })}
      </div>
      <ul className="ml-4 list-disc space-y-0.5 text-muted-foreground">
        {shown.map((w, i) => (
          <li key={i}>
            {t(
              w.exceeded === "ruby"
                ? "export.settings.validation.rubyExceeded"
                : "export.settings.validation.baseExceeded",
              { base: w.base, limit: w.limit, actual: w.actual },
            )}
          </li>
        ))}
        {rest > 0 && (
          <li className="italic">
            {t("export.settings.validation.moreCount", { count: rest })}
          </li>
        )}
      </ul>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// メイン
// ────────────────────────────────────────────────────────────────────

interface Props {
  settings: ExportSettings;
  onChange: (next: ExportSettings) => void;
  userPresets: UserExportPreset[];
  onUserPresetsChange: (next: UserExportPreset[]) => void;
  warnings: RubyLengthWarning[];
}

export function ExportPresetPicker({
  settings,
  onChange,
  userPresets,
  onUserPresetsChange,
  warnings,
}: Props) {
  const { t } = useTranslation();
  const [saveOpen, setSaveOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // 現在選択中のユーザープリセット（exportPresetId は常に "custom" で保存するため構造比較）
  const currentUserPreset = useMemo(
    () => userPresets.find((up) => settingsMatch(up.settings, settings)),
    [userPresets, settings],
  );

  // 注記・警告バナーは「選択中プリセット」(settings.exportPresetId) に紐づける。
  // サブオプション（なろう傍点・pixiv [newpage]）切替時は exportPresetId は維持されるが
  // detect は custom を返す。警告の rubyLimit 出所は exportPresetId 側なので、ラベルも
  // そちらに合わせないと siteLabel が空になり "の文字数上限を超えています" と崩れる。
  const selectedEntry =
    settings.exportPresetId !== "custom"
      ? getSiteEntry(settings.exportPresetId)
      : null;
  const selectedLabel = selectedEntry ? t(selectedEntry.labelKey) : "";

  // トリガーボタンの表示は detect ベース（手動変更で「カスタム」を表示する）。
  const detectedSiteId = currentUserPreset
    ? ("custom" as const)
    : detectExportPreset(settings, settings.exportPresetId);
  const detectedEntry =
    detectedSiteId !== "custom" ? getSiteEntry(detectedSiteId) : null;

  const triggerLabel = currentUserPreset
    ? currentUserPreset.name
    : detectedEntry
      ? t("export.settings.sitePicker.trigger", {
          name: t(detectedEntry.labelKey),
        })
      : settingsMatch(settings, DEFAULT_EXPORT_SETTINGS)
        ? t("export.settings.sitePicker.triggerEmpty")
        : t("export.settings.preset.custom");

  function handleSavePreset(name: string) {
    onUserPresetsChange(addUserPreset(userPresets, name, settings));
  }

  function handleDeleteCurrentUserPreset() {
    if (!currentUserPreset) return;
    const found = findUserPreset(userPresets, currentUserPreset.id);
    if (!found) return;
    if (
      !window.confirm(
        t("export.settings.userPresets.deleteConfirm", { name: found.name }),
      )
    )
      return;
    onUserPresetsChange(removeUserPreset(userPresets, currentUserPreset.id));
  }

  return (
    <div className="border-b border-border bg-muted/20 px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <label className="text-xs font-semibold text-foreground">
          {t("export.settings.preset.section")}
        </label>
        <div className="flex items-center gap-1">
          {currentUserPreset && (
            <button
              type="button"
              onClick={handleDeleteCurrentUserPreset}
              className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
              title={t("export.settings.userPresets.delete")}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setSaveOpen(true)}
            className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
            title={t("export.settings.userPresets.saveCurrent")}
          >
            <Save className="h-3 w-3" />
            {t("export.settings.userPresets.saveCurrent")}
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="flex w-full items-center justify-between rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground hover:bg-accent"
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronRight className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      {/* 注記 */}
      {selectedEntry?.noteKey && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
          {t(selectedEntry.noteKey)}
        </p>
      )}

      {/* サブオプション: pixiv / narou */}
      <PresetSubOptions settings={settings} onChange={onChange} />

      {/* 警告バナー */}
      <WarningBanner warnings={warnings} siteLabel={selectedLabel} />

      <ExportSitePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        settings={settings}
        onChange={onChange}
        userPresets={userPresets}
      />

      <SavePresetDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        onSave={handleSavePreset}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// サブオプション（pixiv / narou のみ）
// ────────────────────────────────────────────────────────────────────

function PresetSubOptions({
  settings,
  onChange,
}: {
  settings: ExportSettings;
  onChange: (next: ExportSettings) => void;
}) {
  const { t } = useTranslation();
  const id = settings.exportPresetId;

  if (id === "pixiv") {
    return (
      <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-xs text-foreground">
        <input
          type="checkbox"
          checked={settings.pixivChapterNewpage}
          onChange={(e) =>
            onChange({ ...settings, pixivChapterNewpage: e.target.checked })
          }
          className="h-3.5 w-3.5 rounded border-border"
        />
        {t("export.settings.presetOption.pixivChapterNewpage")}
      </label>
    );
  }

  if (id === "narou") {
    return (
      <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-xs text-foreground">
        <input
          type="checkbox"
          checked={settings.narouEmphasisMode === "per-char"}
          onChange={(e) => {
            const perChar = e.target.checked;
            onChange({
              ...settings,
              narouEmphasisMode: perChar ? "per-char" : "batch",
              emphasisDotsStyle: perChar
                ? "narou-emphasis-per-char"
                : "narou-emphasis-batch",
            });
          }}
          className="h-3.5 w-3.5 rounded border-border"
        />
        {t("export.settings.presetOption.narouEmphasisPerChar")}
      </label>
    );
  }

  return null;
}
