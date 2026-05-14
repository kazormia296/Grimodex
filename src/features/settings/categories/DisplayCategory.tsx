import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingToggle } from "../components/SettingToggle";
import { SettingSlider } from "../components/SettingSlider";
import { SettingDropdown } from "../components/SettingDropdown";
import { useSettingBoolean, useSettingControl } from "../useSettingControl";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { COLOR_THEMES, DEFAULT_COLOR_THEME } from "@/lib/colorThemes";

const COLOR_THEME_OPTIONS = COLOR_THEMES.map((t) => ({
  value: t.id,
  label: t.name,
}));

const LANGUAGE_OPTIONS = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
];

export function DisplayCategory() {
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

  // Workspace-specific settings (stored in workspace DB)
  const { value: codexHighlight } = useSettingControl(
    "display.codexHighlight",
    "true",
  );
  const setCodexHighlightEnabled = useCodexHighlightStore((s) => s.setEnabled);

  // Master glass toggle — when OFF every other glass-related control
  // below is rendered inert (disabled + dimmed) so it's clear that they
  // have no visual effect until the master is turned ON. Their stored
  // values are preserved across the toggle.
  const { value: glassEnabled } = useSettingBoolean(
    "display.glassEffectEnabled",
    true,
  );
  const glassChildrenDisabled = !glassEnabled;

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
            onChange={(e) => updateGlobal({ colorTheme: e.target.value })}
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
            onChange={(e) => updateGlobal({ theme: e.target.value })}
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
        <SettingRow label={t("settings.display.uiLanguage")}>
          <select
            value={uiLanguage}
            onChange={(e) => updateGlobal({ uiLanguage: e.target.value })}
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
              max={150}
              step={5}
              value={uiScale}
              onChange={(e) =>
                updateGlobal({ uiScale: Number(e.target.value) })
              }
              className="w-32"
            />
            <span className="w-10 text-right text-sm text-muted-foreground">
              {uiScale}%
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

      <SettingSection title={t("settings.display.glass", "Glass")}>
        <SettingRow
          label={t(
            "settings.display.glassEffectEnabled",
            "Enable glass effect",
          )}
          description={t(
            "settings.display.glassEffectEnabledDesc",
            "Applies translucent glass surfaces across the app chrome.",
          )}
        >
          <SettingToggle
            settingKey="display.glassEffectEnabled"
            defaultValue={true}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.display.glassTransparency", "Transparency")}
          description={t(
            "settings.display.glassTransparencyDesc",
            "Higher values let more of what's behind the window show through, uniformly across all glass surfaces.",
          )}
          disabled={glassChildrenDisabled}
        >
          <SettingSlider
            settingKey="display.glassTransparency"
            min={0}
            max={90}
            step={5}
            defaultValue={30}
            format={(v) => `${v}%`}
            disabled={glassChildrenDisabled}
          />
        </SettingRow>
        <SettingRow
          label={t(
            "settings.display.glassBackdropGradient",
            "Tinted backdrop gradient",
          )}
          description={t(
            "settings.display.glassBackdropGradientDesc",
            "Adds a soft tinted highlight at the top corners using the active color theme. Turn off for a flat translucent backdrop.",
          )}
          disabled={glassChildrenDisabled}
        >
          <SettingToggle
            settingKey="display.glassBackdropGradient"
            defaultValue={true}
            disabled={glassChildrenDisabled}
          />
        </SettingRow>
        <SettingRow
          label={t(
            "settings.display.glassNativeVibrancy",
            "macOS native vibrancy",
          )}
          description={t(
            "settings.display.glassNativeVibrancyDesc",
            "Uses the native macOS window material when available.",
          )}
          disabled={glassChildrenDisabled}
        >
          <SettingToggle
            settingKey="display.glassNativeVibrancy"
            defaultValue={true}
            disabled={glassChildrenDisabled}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.display.glassSurfaceShell", "Window and header")}
          disabled={glassChildrenDisabled}
        >
          <SettingToggle
            settingKey="display.glassSurfaceShell"
            defaultValue={true}
            disabled={glassChildrenDisabled}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.display.glassSurfaceDock", "Dock and tabs")}
          disabled={glassChildrenDisabled}
        >
          <SettingToggle
            settingKey="display.glassSurfaceDock"
            defaultValue={true}
            disabled={glassChildrenDisabled}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.display.glassSurfacePanels", "Panels")}
          disabled={glassChildrenDisabled}
        >
          <SettingToggle
            settingKey="display.glassSurfacePanels"
            defaultValue={true}
            disabled={glassChildrenDisabled}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.display.glassSurfaceChat", "Chat")}
          disabled={glassChildrenDisabled}
        >
          <SettingToggle
            settingKey="display.glassSurfaceChat"
            defaultValue={true}
            disabled={glassChildrenDisabled}
          />
        </SettingRow>
        <SettingRow
          label={t(
            "settings.display.glassSurfacePopovers",
            "Popovers and dialogs",
          )}
          disabled={glassChildrenDisabled}
        >
          <SettingToggle
            settingKey="display.glassSurfacePopovers"
            defaultValue={true}
            disabled={glassChildrenDisabled}
          />
        </SettingRow>
        <SettingRow
          label={t(
            "settings.display.glassSurfaceEditorChrome",
            "Editor chrome",
          )}
          disabled={glassChildrenDisabled}
        >
          <SettingToggle
            settingKey="display.glassSurfaceEditorChrome"
            defaultValue={true}
            disabled={glassChildrenDisabled}
          />
        </SettingRow>
      </SettingSection>

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
