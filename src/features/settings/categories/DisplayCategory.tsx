import { useEffect } from "react";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingToggle } from "../components/SettingToggle";
import { SettingSlider } from "../components/SettingSlider";
import { SettingDropdown } from "../components/SettingDropdown";
import { useSettingControl } from "../useSettingControl";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { COLOR_THEMES, DEFAULT_COLOR_THEME } from "@/lib/colorThemes";

const LIGHT_DARK_OPTIONS = [
  { value: "system", label: "システム" },
  { value: "dark", label: "ダーク" },
  { value: "light", label: "ライト" },
];

const COLOR_THEME_OPTIONS = COLOR_THEMES.map((t) => ({
  value: t.id,
  label: t.name,
}));

const LANGUAGE_OPTIONS = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
];

const CODEX_STYLE_OPTIONS = [
  { value: "color-text", label: "文字色" },
  { value: "underline", label: "下線" },
];

export function DisplayCategory() {
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

  // Sync codex highlight to store
  useEffect(() => {
    setCodexHighlightEnabled(codexHighlight === "true");
  }, [codexHighlight, setCodexHighlightEnabled]);

  return (
    <div className="p-6">
      <SettingSection title="テーマ">
        <SettingRow label="カラーテーマ">
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
        <SettingRow label="ライト / ダーク">
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

      <SettingSection title="UI">
        <SettingRow label="UI 言語">
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
          label="UI スケール"
          description="ウィンドウ全体のズーム (80〜150%)"
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
        <SettingRow label="シーンツリーに文字数を表示">
          <SettingToggle
            settingKey="display.showWordCount"
            defaultValue={true}
          />
        </SettingRow>
        <SettingRow label="シーンツリーに AI 帰属バッジを表示">
          <SettingToggle
            settingKey="display.showAiBadge"
            defaultValue={false}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title="Codex ハイライト">
        <SettingRow label="Codex ハイライトを有効化">
          <SettingToggle
            settingKey="display.codexHighlight"
            defaultValue={true}
          />
        </SettingRow>
        <SettingRow label="ハイライトスタイル">
          <SettingDropdown
            settingKey="display.codexHighlightStyle"
            options={CODEX_STYLE_OPTIONS}
            defaultValue="color-text"
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title="帰属表示">
        <SettingRow
          label="帰属ハイライトの不透明度"
          description="Attribution 表示時の背景色の強さ (5〜25%)"
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
