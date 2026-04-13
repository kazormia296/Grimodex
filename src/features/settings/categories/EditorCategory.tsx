import { useTranslation } from "react-i18next";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingToggle } from "../components/SettingToggle";
import { SettingSlider } from "../components/SettingSlider";
import { SettingDropdown } from "../components/SettingDropdown";
import { useSettingBoolean } from "../useSettingControl";

export function EditorCategory() {
  const { t } = useTranslation();

  const WORD_BREAK_OPTIONS = [
    { value: "auto-phrase", label: t("settings.editor.wordBreakAutoPhrase") },
    { value: "normal", label: t("settings.editor.wordBreakNormal") },
    { value: "break-all", label: t("settings.editor.wordBreakBreakAll") },
    { value: "keep-all", label: t("settings.editor.wordBreakKeepAll") },
  ];

  const LINE_BREAK_OPTIONS = [
    { value: "strict", label: t("settings.editor.lineBreakStrict") },
    { value: "normal", label: t("settings.editor.lineBreakNormal") },
    { value: "loose", label: t("settings.editor.lineBreakLoose") },
    { value: "auto", label: t("settings.editor.lineBreakAuto") },
  ];

  const FONT_FAMILY_OPTIONS = [
    { value: "serif", label: t("settings.editor.fontDefault") },
    { value: '"Noto Serif JP", serif', label: "Noto Serif JP" },
    { value: '"Noto Sans JP", sans-serif', label: "Noto Sans JP" },
    { value: '"BIZ UDMincho", serif', label: "BIZ UDMincho" },
    { value: '"BIZ UDGothic", sans-serif', label: "BIZ UDGothic" },
    { value: '"Source Han Serif JP", serif', label: "Source Han Serif" },
    { value: "monospace", label: t("settings.editor.fontMono") },
  ];

  const { value: disableAll, setValue: setDisableAll } = useSettingBoolean(
    "editor.disableAllAnimations",
    false,
  );

  const { value: smoothCaret, setValue: setSmoothCaret } = useSettingBoolean(
    "editor.smoothCaret",
    true,
  );
  const { value: cursorBlink, setValue: setCursorBlink } = useSettingBoolean(
    "editor.cursorBlink",
    true,
  );
  const { value: fadeIn, setValue: setFadeIn } = useSettingBoolean(
    "editor.characterFadeIn",
    false,
  );
  const { value: fadeOut, setValue: setFadeOut } = useSettingBoolean(
    "editor.characterFadeOut",
    false,
  );

  function handleDisableAll(v: boolean) {
    setDisableAll(v);
    if (v) {
      setSmoothCaret(false);
      setCursorBlink(false);
      setFadeIn(false);
      setFadeOut(false);
    }
  }

  return (
    <div className="p-6">
      <SettingSection title={t("settings.editor.textDisplay")}>
        <SettingRow label={t("settings.editor.font")}>
          <SettingDropdown
            settingKey="editor.fontFamily"
            options={FONT_FAMILY_OPTIONS}
            defaultValue="serif"
          />
        </SettingRow>
        <SettingRow label={t("settings.editor.fontSize")}>
          <SettingSlider
            settingKey="editor.fontSize"
            min={14}
            max={24}
            step={1}
            defaultValue={18}
            format={(v) => `${v}px`}
          />
        </SettingRow>
        <SettingRow label={t("settings.editor.lineHeight")}>
          <SettingSlider
            settingKey="editor.lineHeight"
            min={1.2}
            max={3.0}
            step={0.1}
            defaultValue={2.0}
            format={(v) => v.toFixed(1)}
          />
        </SettingRow>
        <SettingRow label={t("settings.editor.maxWidth")}>
          <SettingSlider
            settingKey="editor.maxContentWidth"
            min={480}
            max={960}
            step={40}
            defaultValue={720}
            format={(v) => `${v}px`}
          />
        </SettingRow>
        <SettingRow label={t("settings.editor.paragraphSpacing")}>
          <SettingSlider
            settingKey="editor.paragraphSpacing"
            min={0}
            max={24}
            step={2}
            defaultValue={8}
            format={(v) => `${v}px`}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.editor.wordBreak")}
          description={t("settings.editor.wordBreakDesc")}
        >
          <SettingDropdown
            settingKey="editor.wordBreak"
            options={WORD_BREAK_OPTIONS}
            defaultValue="normal"
          />
        </SettingRow>
        <SettingRow
          label={t("settings.editor.lineBreak")}
          description={t("settings.editor.lineBreakDesc")}
        >
          <SettingDropdown
            settingKey="editor.lineBreak"
            options={LINE_BREAK_OPTIONS}
            defaultValue="strict"
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.editor.experience")}>
        <SettingRow
          label={t("settings.editor.typewriterMode")}
          description={t("settings.editor.typewriterModeDesc")}
        >
          <SettingToggle
            settingKey="editor.typewriterMode"
            defaultValue={false}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.editor.autoSave")}
          description={t("settings.editor.autoSaveDesc")}
        >
          <SettingSlider
            settingKey="editor.autoSaveDelay"
            min={500}
            max={10000}
            step={500}
            defaultValue={2000}
            format={(v) => t("settings.editor.autoSaveFormat", { v: v / 1000 })}
          />
        </SettingRow>
        <SettingRow label={t("settings.editor.spellCheck")}>
          <SettingToggle settingKey="editor.spellCheck" defaultValue={false} />
        </SettingRow>
        <SettingRow
          label={t("settings.editor.smartQuotes")}
          description={t("settings.editor.smartQuotesDesc")}
        >
          <SettingToggle settingKey="editor.smartQuotes" defaultValue={false} />
        </SettingRow>
        <SettingRow
          label={t("settings.editor.smartDashes")}
          description={t("settings.editor.smartDashesDesc")}
        >
          <SettingToggle settingKey="editor.smartDashes" defaultValue={false} />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.editor.inlineAi")}>
        <SettingRow label={t("settings.editor.slashCommand")}>
          <SettingToggle
            settingKey="editor.inlineAiCommand"
            defaultValue={true}
          />
        </SettingRow>
        <SettingRow label={t("settings.editor.paletteShortcut")}>
          <SettingToggle
            settingKey="editor.inlineAiShortcut"
            defaultValue={true}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.editor.animation")}>
        <SettingRow
          label={t("settings.editor.disableAll")}
          description={t("settings.editor.disableAllDesc")}
        >
          <DisableAllToggle value={disableAll} onChange={handleDisableAll} />
        </SettingRow>
        <SettingRow label={t("settings.editor.smoothCaret")}>
          <AnimToggle
            value={smoothCaret}
            onChange={setSmoothCaret}
            disabled={disableAll}
          />
        </SettingRow>
        <SettingRow label={t("settings.editor.cursorBlink")}>
          <AnimToggle
            value={cursorBlink}
            onChange={setCursorBlink}
            disabled={disableAll}
          />
        </SettingRow>
        <SettingRow label={t("settings.editor.fadeIn")}>
          <AnimToggle
            value={fadeIn}
            onChange={setFadeIn}
            disabled={disableAll}
          />
        </SettingRow>
        <SettingRow label={t("settings.editor.fadeOut")}>
          <AnimToggle
            value={fadeOut}
            onChange={setFadeOut}
            disabled={disableAll}
          />
        </SettingRow>
      </SettingSection>
    </div>
  );
}

function DisableAllToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
        value ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          value ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function AnimToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${
        value ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          value ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}
