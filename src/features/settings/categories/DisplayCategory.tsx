import { useEffect } from "react";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingToggle } from "../components/SettingToggle";
import { SettingSlider } from "../components/SettingSlider";
import { SettingDropdown } from "../components/SettingDropdown";
import { SettingColorPicker } from "../components/SettingColorPicker";
import { useSettingControl } from "../useSettingControl";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";

const THEME_OPTIONS = [
  { value: "system", label: "システム" },
  { value: "dark", label: "ダーク" },
  { value: "light", label: "ライト" },
];

const LANGUAGE_OPTIONS = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
];

const CODEX_STYLE_OPTIONS = [
  { value: "color-text", label: "文字色" },
  { value: "underline", label: "下線" },
];

export function DisplayCategory() {
  const { value: theme } = useSettingControl("display.theme", "system");
  const { value: accentColor, setValue: setAccentColor } = useSettingControl(
    "display.accentColor",
    "#7F77DD",
  );
  const { value: codexHighlight } = useSettingControl(
    "display.codexHighlight",
    "true",
  );
  const setCodexHighlightEnabled = useCodexHighlightStore((s) => s.setEnabled);

  // Apply theme to <html> element
  useEffect(() => {
    const html = document.documentElement;
    if (theme === "dark") {
      html.classList.add("dark");
    } else if (theme === "light") {
      html.classList.remove("dark");
    } else {
      // system
      const prefersDark = window.matchMedia(
        "(prefers-color-scheme: dark)",
      ).matches;
      html.classList.toggle("dark", prefersDark);
    }
  }, [theme]);

  // Sync codex highlight to store
  useEffect(() => {
    setCodexHighlightEnabled(codexHighlight === "true");
  }, [codexHighlight, setCodexHighlightEnabled]);

  return (
    <div className="p-6">
      <SettingSection title="テーマ">
        <SettingRow label="カラーテーマ">
          <SettingDropdown
            settingKey="display.theme"
            options={THEME_OPTIONS}
            defaultValue="system"
          />
        </SettingRow>
        <SettingRow label="アクセントカラー">
          <SettingColorPicker value={accentColor} onChange={setAccentColor} />
        </SettingRow>
      </SettingSection>

      <SettingSection title="UI">
        <SettingRow label="UI 言語">
          <SettingDropdown
            settingKey="display.uiLanguage"
            options={LANGUAGE_OPTIONS}
            defaultValue="ja"
          />
        </SettingRow>
        <SettingRow
          label="UI スケール"
          description="ウィンドウ全体のズーム (80〜150%)"
        >
          <SettingSlider
            settingKey="display.uiScale"
            min={80}
            max={150}
            step={5}
            defaultValue={100}
            format={(v) => `${v}%`}
          />
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
