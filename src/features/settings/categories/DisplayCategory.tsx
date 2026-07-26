import { useEffect, useRef, useState } from "react";
import { Palette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingToggle } from "../components/SettingToggle";
import { SettingSlider } from "../components/SettingSlider";
import { SettingDropdown } from "../components/SettingDropdown";
import { FontFamilySelect } from "../components/FontFamilySelect";
import { useSettingControl } from "../useSettingControl";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { COLOR_THEMES, DEFAULT_COLOR_THEME } from "@/lib/colorThemes";
import { clampUiScalePercent, getUiScaleMaxPercent } from "@/lib/uiScale";

const COLOR_THEME_OPTIONS = COLOR_THEMES.map((t) => ({
  value: t.id,
  label: t.name,
}));

const LANGUAGE_OPTIONS = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
];

interface DisplayCategoryProps {
  onOpenBackgroundStudio?: () => void;
}

export function DisplayCategory({
  onOpenBackgroundStudio,
}: DisplayCategoryProps = {}) {
  const { t } = useTranslation();

  const LIGHT_DARK_OPTIONS = [
    { value: "system", label: t("settings.display.system") },
    { value: "dark", label: t("settings.display.dark") },
    { value: "light", label: t("settings.display.light") },
  ];

  const CODEX_STYLE_OPTIONS = [
    { value: "color-text", label: t("settings.display.colorText") },
    { value: "underline", label: t("settings.display.underline") },
  ];

  // Global settings (stored in global-settings.json, available before workspace open)
  const theme = useWorkspaceStore((s) => s.globalSettings?.theme ?? "system");
  const colorTheme = useWorkspaceStore(
    (s) => s.globalSettings?.colorTheme ?? DEFAULT_COLOR_THEME,
  );
  const uiLanguage = useWorkspaceStore(
    (s) => s.globalSettings?.uiLanguage ?? "ja",
  );
  const uiScale = useWorkspaceStore((s) => s.globalSettings?.uiScale ?? 100);
  const updateGlobal = useWorkspaceStore((s) => s.updateGlobalSettings);

  // グローバル設定の保存は楽観的更新→失敗時に黙ってリバートするため、戻り値の false を
  // 拾ってユーザーへ通知する（無言で元に戻ると「ドロップダウンが効かない」ように見える）。
  const commitGlobal = async (updates: Parameters<typeof updateGlobal>[0]) => {
    const ok = await updateGlobal(updates);
    if (!ok) toast.error(t("common.saveFailed"));
  };

  const uiScaleSliderMax = getUiScaleMaxPercent();
  const clampedUiScale = clampUiScalePercent(uiScale);

  /** True while dragging the UI scale slider with pointer — avoids zooming mid-drag */
  const uiScalePointerDragRef = useRef(false);
  const [uiScaleDraft, setUiScaleDraft] = useState(clampedUiScale);
  /** Last value committed to the store. Guards against duplicate IPC writes when
   *  `onPointerUp` and a trailing `onChange` both fire for the same release. */
  const uiScaleCommittedRef = useRef(clampedUiScale);

  useEffect(() => {
    if (uiScalePointerDragRef.current) return;
    setUiScaleDraft(clampedUiScale);
    uiScaleCommittedRef.current = clampedUiScale;
  }, [clampedUiScale]);

  const commitUiScale = (next: number) => {
    if (uiScaleCommittedRef.current === next) return;
    uiScaleCommittedRef.current = next;
    void updateGlobal({ uiScale: next });
  };

  // Workspace-specific settings (stored in workspace DB)
  const { value: codexHighlight } = useSettingControl(
    "display.codexHighlight",
    "true",
  );
  const setCodexHighlightEnabled = useCodexHighlightStore((s) => s.setEnabled);

  // Sync codex highlight to store
  useEffect(() => {
    setCodexHighlightEnabled(codexHighlight === "true");
  }, [codexHighlight, setCodexHighlightEnabled]);

  return (
    <div className="p-6">
      <SettingSection title={t("settings.display.theme")}>
        <SettingRow label={t("settings.display.colorTheme")}>
          <select
            value={colorTheme}
            onChange={(e) => void commitGlobal({ colorTheme: e.target.value })}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {COLOR_THEME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label={t("settings.display.lightDark")}>
          <select
            value={theme}
            onChange={(e) => void commitGlobal({ theme: e.target.value })}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {LIGHT_DARK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.display.ui")}>
        <SettingRow label={t("settings.display.uiFont")}>
          <FontFamilySelect settingKey="display.uiFontFamily" />
        </SettingRow>
        <SettingRow label={t("settings.display.uiLanguage")}>
          <select
            value={uiLanguage}
            onChange={(e) => void commitGlobal({ uiLanguage: e.target.value })}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {LANGUAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          label={t("settings.display.uiScale")}
          description={t("settings.display.uiScaleDesc")}
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={80}
              max={uiScaleSliderMax}
              step={5}
              value={uiScaleDraft}
              onPointerDown={(e) => {
                uiScalePointerDragRef.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerUp={(e) => {
                uiScalePointerDragRef.current = false;
                try {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                } catch {
                  /* already released */
                }
                const next = Number(e.currentTarget.value);
                setUiScaleDraft(next);
                commitUiScale(next);
              }}
              onPointerCancel={() => {
                uiScalePointerDragRef.current = false;
                setUiScaleDraft(clampedUiScale);
              }}
              onChange={(e) => {
                const next = Number(e.target.value);
                setUiScaleDraft(next);
                if (!uiScalePointerDragRef.current) {
                  commitUiScale(next);
                }
              }}
              className="w-32"
            />
            <span className="w-10 text-right text-sm text-muted-foreground">
              {uiScaleDraft}%
            </span>
          </div>
        </SettingRow>
        <SettingRow label={t("settings.display.showWordCount")}>
          <SettingToggle
            settingKey="display.showWordCount"
            defaultValue={true}
          />
        </SettingRow>
        <SettingRow label={t("settings.display.showAiBadge")}>
          <SettingToggle
            settingKey="display.showAiBadge"
            defaultValue={false}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.display.animations")}>
        <SettingRow
          label={t("settings.display.reduceMotion")}
          description={t("settings.display.reduceMotionDesc")}
        >
          <SettingToggle
            settingKey="display.reduceMotion"
            defaultValue={false}
          />
        </SettingRow>
      </SettingSection>

      {onOpenBackgroundStudio && (
        <SettingSection title={t("settings.display.editorBackground")}>
          <SettingRow
            label={t("settings.display.backgroundStudio")}
            description={t("settings.display.backgroundStudioDesc")}
          >
            <button
              type="button"
              aria-label={t("editor.background.open")}
              onClick={onOpenBackgroundStudio}
              className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
            >
              <Palette className="h-4 w-4" aria-hidden />
              {t("settings.display.openBackgroundStudio")}
            </button>
          </SettingRow>
        </SettingSection>
      )}

      <SettingSection title={t("settings.display.codexHighlight")}>
        <SettingRow label={t("settings.display.enableHighlight")}>
          <SettingToggle
            settingKey="display.codexHighlight"
            defaultValue={true}
          />
        </SettingRow>
        <SettingRow label={t("settings.display.highlightStyle")}>
          <SettingDropdown
            settingKey="display.codexHighlightStyle"
            options={CODEX_STYLE_OPTIONS}
            defaultValue="color-text"
          />
        </SettingRow>
        <SettingRow
          label={t("settings.display.codexOpacity")}
          description={t("settings.display.codexOpacityDesc")}
        >
          <SettingSlider
            settingKey="display.codexHighlightOpacity"
            min={5}
            max={25}
            step={1}
            defaultValue={10}
            format={(v) => `${v * 10}%`}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.display.attribution")}>
        <SettingRow
          label={t("settings.display.attributionOpacity")}
          description={t("settings.display.attributionOpacityDesc")}
        >
          <SettingSlider
            settingKey="display.attributionHighlightOpacity"
            min={5}
            max={25}
            step={1}
            defaultValue={10}
            format={(v) => `${v}%`}
          />
        </SettingRow>
      </SettingSection>
    </div>
  );
}
