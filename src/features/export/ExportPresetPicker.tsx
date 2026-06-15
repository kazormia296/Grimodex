import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Save, Trash2, AlertTriangle } from "lucide-react";
import type { ExportPresetId, ExportSettings } from "./types";
import {
  EXPORT_PRESETS,
  applyExportPreset,
  detectExportPreset,
  validateUserPresetName,
} from "./exportPresets";
import {
  getPresetGroups,
  type PresetGroup,
  type PresetGroups,
} from "./exportPresetCatalog";
import {
  addUserPreset,
  findUserPreset,
  removeUserPreset,
  type UserExportPreset,
} from "./exportUserPresets";
import type { RubyLengthWarning } from "./exportValidation";
import { useSettingsStore } from "@/features/settings/settingsStore";

// ────────────────────────────────────────────────────────────────────
// プリセット Select の選択肢構築
// ────────────────────────────────────────────────────────────────────

type SelectValue = `preset:${ExportPresetId}` | `user:${string}`;

interface OptGroupDesc {
  /** optgroup ラベルの i18n キー */
  labelKey: string;
  options: { value: SelectValue; label: string }[];
}

/**
 * catalog の言語別グルーピングにユーザープリセットを足して、
 * 表示順どおりの optgroup 記述子配列に変換する。custom はグループ外なので含めない。
 */
function buildOptGroups(
  groups: PresetGroups,
  userPresets: UserExportPreset[],
  t: (key: string) => string,
): OptGroupDesc[] {
  const fromPresetGroup = (g: PresetGroup): OptGroupDesc => ({
    labelKey: g.labelKey,
    options: g.ids.map((id) => ({
      value: `preset:${id}` as SelectValue,
      label: t(EXPORT_PRESETS[id].labelKey),
    })),
  });
  const result: OptGroupDesc[] = [
    fromPresetGroup(groups.primary),
    fromPresetGroup(groups.generic),
    fromPresetGroup(groups.secondary),
  ];
  if (userPresets.length > 0) {
    result.push({
      labelKey: "export.settings.preset.userPresetsGroup",
      options: userPresets.map((up) => ({
        value: `user:${up.id}` as SelectValue,
        label: up.name,
      })),
    });
  }
  return result;
}

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
  // 執筆言語に応じてプリセットの並びを変える（書体・行間等と同じ projectLanguage 基準）。
  // ExportDialog の projectLanguage state と二重管理しないよう store から直接取得する。
  const projectLanguage = useSettingsStore((s) => s.projectLanguage);

  // 現在の Select 値: ユーザープリセットなら "user:<id>"、ビルトインなら "preset:<id>"
  const currentValue = useMemo<SelectValue>(() => {
    // ユーザープリセットの settings と完全一致するものがあれば優先表示
    // （exportPresetId は常に "custom" として保存しているため、構造比較）
    const userMatch = userPresets.find((up) =>
      settingsStructurallyEqual(up.settings, settings),
    );
    if (userMatch) return `user:${userMatch.id}` as SelectValue;
    const detected = detectExportPreset(settings, settings.exportPresetId);
    return `preset:${detected}` as SelectValue;
  }, [settings, userPresets]);

  const optGroups = useMemo(
    () =>
      buildOptGroups(
        getPresetGroups(projectLanguage, settings.exportPresetId),
        userPresets,
        t,
      ),
    [projectLanguage, settings.exportPresetId, userPresets, t],
  );

  const builtinId =
    settings.exportPresetId !== "custom"
      ? (settings.exportPresetId as Exclude<ExportPresetId, "custom">)
      : null;
  const builtinDef = builtinId ? EXPORT_PRESETS[builtinId] : null;
  const siteLabel = builtinDef ? t(builtinDef.labelKey) : "";

  function handleSelectChange(value: SelectValue) {
    if (value.startsWith("user:")) {
      const id = value.slice(5);
      const found = findUserPreset(userPresets, id);
      if (found) {
        onChange({ ...found.settings });
      }
      return;
    }
    const presetId = value.slice("preset:".length) as ExportPresetId;
    onChange(applyExportPreset(presetId, settings));
  }

  function handleSavePreset(name: string) {
    onUserPresetsChange(addUserPreset(userPresets, name, settings));
  }

  function handleDeleteCurrentUserPreset() {
    if (!currentValue.startsWith("user:")) return;
    const id = currentValue.slice(5);
    const found = findUserPreset(userPresets, id);
    if (!found) return;
    if (
      !window.confirm(
        t("export.settings.userPresets.deleteConfirm", { name: found.name }),
      )
    )
      return;
    onUserPresetsChange(removeUserPreset(userPresets, id));
  }

  const isUserPresetSelected = currentValue.startsWith("user:");

  return (
    <div className="border-b border-border bg-muted/20 px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <label className="text-xs font-semibold text-foreground">
          {t("export.settings.preset.section")}
        </label>
        <div className="flex items-center gap-1">
          {isUserPresetSelected && (
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

      <select
        value={currentValue}
        onChange={(e) => handleSelectChange(e.target.value as SelectValue)}
        className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
      >
        <option value="preset:custom">
          {t("export.settings.preset.custom")}
        </option>
        {optGroups.map((g) =>
          g.options.length > 0 ? (
            <optgroup key={g.labelKey} label={t(g.labelKey)}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ) : null,
        )}
      </select>

      {/* 注記 */}
      {builtinDef?.descriptionKey && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
          {t(builtinDef.descriptionKey)}
        </p>
      )}

      {/* サブオプション: pixiv / narou */}
      <PresetSubOptions settings={settings} onChange={onChange} />

      {/* 警告バナー */}
      <WarningBanner warnings={warnings} siteLabel={siteLabel} />

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

// ────────────────────────────────────────────────────────────────────
// 構造比較（ユーザープリセット選択検出用）
// ────────────────────────────────────────────────────────────────────

const COMPARED_FIELDS: (keyof ExportSettings)[] = [
  "format",
  "folderHeading",
  "folderHeadingStyle",
  "folderHeadingFormat",
  "sceneDivider",
  "sceneDividerCustom",
  "sceneTitle",
  "rubyStyle",
  "emphasisDotsStyle",
  "sceneBreakStyle",
  "sceneBreakCustom",
  "pixivChapterNewpage",
  "narouEmphasisMode",
];

function settingsStructurallyEqual(
  a: ExportSettings,
  b: ExportSettings,
): boolean {
  for (const k of COMPARED_FIELDS) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
