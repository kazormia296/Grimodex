import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Search, Check } from "lucide-react";
import type { ExportSettings } from "./types";
import {
  applyExportPreset,
  detectExportPreset,
  settingsMatch,
} from "./exportPresets";
import {
  RUBY_PROFILES,
  SITE_REGISTRY,
  getSectionOrder,
  siteIdsInSection,
} from "./rubyProfiles";
import type { UserExportPreset } from "./exportUserPresets";
import { useSettingsStore } from "@/features/settings/settingsStore";

interface Props {
  open: boolean;
  onClose: () => void;
  settings: ExportSettings;
  onChange: (next: ExportSettings) => void;
  userPresets: UserExportPreset[];
}

/**
 * 投稿サイト選択ダイアログ。系統（プロファイル）ごとの見出し + 記法例 + 該当サイト一覧で表示する。
 *
 * ExportDialog (AnimatedOverlay) は scale animation の transform を持つため、子の position:fixed が
 * その内側に閉じ込められる。SavePresetDialog と同じく createPortal(document.body) + z-[60] で
 * viewport 基準に出し、Escape は capture phase で先取りして親 ExportDialog に伝播させない。
 */
export function ExportSitePickerDialog({
  open,
  onClose,
  settings,
  onChange,
  userPresets,
}: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // 執筆言語が英語のときは英語圏セクションを先頭に並べ替える。
  const projectLanguage = useSettingsStore((s) => s.projectLanguage);

  useEffect(() => {
    if (open) {
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      // IME 変換キャンセルの Escape でダイアログを閉じない
      if (e.key === "Escape" && !e.isComposing) {
        e.stopImmediatePropagation();
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [open, onClose]);

  // 現在選択中: ユーザープリセット一致を優先、なければ detect でサイト ID。
  const currentUserPresetId = useMemo(() => {
    const m = userPresets.find((up) => settingsMatch(up.settings, settings));
    return m?.id ?? null;
  }, [userPresets, settings]);

  const currentSiteId = useMemo(() => {
    if (currentUserPresetId) return null;
    const detected = detectExportPreset(settings, settings.exportPresetId);
    return detected === "custom" ? null : detected;
  }, [currentUserPresetId, settings]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const siteMatches = (id: string) =>
    t(SITE_REGISTRY[id].labelKey).toLowerCase().includes(q) ||
    t(RUBY_PROFILES[SITE_REGISTRY[id].profileId].exampleKey)
      .toLowerCase()
      .includes(q);

  function selectSite(id: string) {
    onChange(
      applyExportPreset(id as ExportSettings["exportPresetId"], settings),
    );
    onClose();
  }
  function selectUserPreset(up: UserExportPreset) {
    onChange({ ...up.settings });
    onClose();
  }

  const sections = getSectionOrder(projectLanguage)
    .map((section) => {
      const allIds = siteIdsInSection(section.id);
      const sectionLabel = t(section.labelKey);
      const sectionMatches = sectionLabel.toLowerCase().includes(q);
      const ids = q
        ? allIds.filter((id) => sectionMatches || siteMatches(id))
        : allIds;
      // 系統が単一プロファイルなら見出し下に記法例を出す。複数なら各チップ側で出す。
      const profileIds = new Set(
        allIds.map((id) => SITE_REGISTRY[id].profileId),
      );
      const homogeneousProfile =
        profileIds.size === 1 ? [...profileIds][0] : null;
      return { section, sectionLabel, ids, homogeneousProfile };
    })
    .filter((s) => s.ids.length > 0);

  const userMatches = q
    ? userPresets.filter((up) => up.name.toLowerCase().includes(q))
    : userPresets;

  const hasResults = sections.length > 0 || userMatches.length > 0;

  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[80vh] w-[440px] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label={t("export.settings.sitePicker.title")}
      >
        {/* ヘッダ + 検索 */}
        <div className="border-b border-border p-3">
          <h3 className="mb-2 text-sm font-semibold text-foreground">
            {t("export.settings.sitePicker.title")}
          </h3>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("export.settings.sitePicker.searchPlaceholder")}
              className="w-full rounded border border-border bg-background py-1.5 pl-7 pr-2 text-sm"
            />
          </div>
        </div>

        {/* 本体 */}
        <div className="flex-1 overflow-y-auto p-3">
          {!hasResults && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {t("export.settings.sitePicker.noResults")}
            </p>
          )}

          {sections.map(
            ({ section, sectionLabel, ids, homogeneousProfile }) => (
              <section key={section.id} className="mb-4 last:mb-0">
                <h4 className="text-xs font-semibold text-foreground">
                  {sectionLabel}
                </h4>
                {homogeneousProfile && (
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {t(RUBY_PROFILES[homogeneousProfile].exampleKey)}
                  </p>
                )}
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {ids.map((id) => {
                    const entry = SITE_REGISTRY[id];
                    const selected = id === currentSiteId;
                    const note = entry.noteKey ? t(entry.noteKey) : undefined;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => selectSite(id)}
                        title={note}
                        aria-pressed={selected}
                        className={
                          "flex flex-col items-start rounded border px-2 py-1 text-left text-xs transition-colors " +
                          (selected
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border bg-background text-foreground hover:bg-accent")
                        }
                      >
                        <span className="flex items-center gap-1">
                          {selected && (
                            <Check className="h-3 w-3 text-primary" />
                          )}
                          {t(entry.labelKey)}
                        </span>
                        {!homogeneousProfile && (
                          <span className="font-mono text-[9px] text-muted-foreground">
                            {t(RUBY_PROFILES[entry.profileId].exampleKey)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            ),
          )}

          {/* ユーザー定義 */}
          {userMatches.length > 0 && (
            <section className="mb-0">
              <h4 className="text-xs font-semibold text-foreground">
                {t("export.settings.preset.userPresetsGroup")}
              </h4>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {userMatches.map((up) => {
                  const selected = up.id === currentUserPresetId;
                  return (
                    <button
                      key={up.id}
                      type="button"
                      onClick={() => selectUserPreset(up)}
                      aria-pressed={selected}
                      className={
                        "flex items-center gap-1 rounded border px-2 py-1 text-xs transition-colors " +
                        (selected
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-background text-foreground hover:bg-accent")
                      }
                    >
                      {selected && <Check className="h-3 w-3 text-primary" />}
                      {up.name}
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
