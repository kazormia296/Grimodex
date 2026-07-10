import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { SettingSection } from "../components/SettingSection";
import { SettingScopeHeader } from "../components/SettingScopeHeader";
import { SettingRow } from "../components/SettingRow";
import { SettingToggle } from "../components/SettingToggle";
import { Switch } from "@/components/ui/switch";
import { SettingSlider } from "../components/SettingSlider";
import { CaretMotionPreview } from "../components/CaretMotionPreview";
import { CaretSlideResetButton } from "../components/CaretSlideResetButton";
import { SettingNumberInput } from "../components/SettingNumberInput";
import { SettingDropdown } from "../components/SettingDropdown";
import { FontFamilySelect } from "../components/FontFamilySelect";
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

  const TEXT_AUTOSPACE_OPTIONS = [
    { value: "normal", label: t("settings.editor.textAutospaceNormal") },
    { value: "no-autospace", label: t("settings.editor.textAutospaceOff") },
  ];

  const TATE_CHU_YOKO_OPTIONS = [
    { value: "off", label: t("settings.editor.tateChuYokoOff") },
    { value: "2", label: t("settings.editor.tateChuYoko2") },
    { value: "all", label: t("settings.editor.tateChuYokoAll") },
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
  const { value: fadeOut, setValue: setFadeOut } = useSettingBoolean(
    "editor.characterFadeOut",
    false,
  );

  const PARAGRAPH_INDENT_OPTIONS = [
    { value: "0", label: t("settings.editor.paragraphIndentOff") },
    { value: "1", label: t("settings.editor.paragraphIndent1") },
    { value: "2", label: t("settings.editor.paragraphIndent2") },
  ];

  const LINEAR_BEAT_DISPLAY_OPTIONS = [
    { value: "normal", label: t("settings.editor.linearBeatDisplayNormal") },
    {
      value: "collapsed",
      label: t("settings.editor.linearBeatDisplayCollapsed"),
    },
    { value: "hidden", label: t("settings.editor.linearBeatDisplayHidden") },
  ];

  // 「全アニメ無効」は子トグルを false に焼くため、ON にした時点の値を退避し、OFF に
  // 戻したら復元する（さもないと子の設定が永久に失われ、解除しても OFF のままになる）。
  const prevAnimRef = useRef<{
    smoothCaret: boolean;
    cursorBlink: boolean;
    fadeOut: boolean;
  } | null>(null);

  function handleDisableAll(v: boolean) {
    setDisableAll(v);
    if (v) {
      prevAnimRef.current = { smoothCaret, cursorBlink, fadeOut };
      setSmoothCaret(false);
      setCursorBlink(false);
      setFadeOut(false);
    } else if (prevAnimRef.current) {
      // この session で退避した値があるときだけ復元（無ければ現状維持＝悪化させない）。
      setSmoothCaret(prevAnimRef.current.smoothCaret);
      setCursorBlink(prevAnimRef.current.cursorBlink);
      setFadeOut(prevAnimRef.current.fadeOut);
      prevAnimRef.current = null;
    }
  }

  return (
    <div className="p-6">
      <SettingScopeHeader title={t("settings.scopeGlobal")} />
      <SettingSection title={t("settings.editor.textDisplay")}>
        <SettingRow label={t("settings.editor.font")}>
          <FontFamilySelect
            settingKey="editor.fontFamily"
            defaultValue={'"Noto Serif JP"'}
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
        <SettingRow
          label={t("settings.editor.markdownStrictLineBreaks")}
          description={t("settings.editor.markdownStrictLineBreaksDesc")}
        >
          <SettingToggle
            settingKey="editor.markdownStrictLineBreaks"
            defaultValue={false}
          />
        </SettingRow>
        <SettingRow label={t("settings.editor.bubbleMenu")}>
          <SettingToggle settingKey="editor.bubbleMenu" defaultValue={true} />
        </SettingRow>
        <SettingRow
          label={t("settings.editor.aozoraInput")}
          description={t("settings.editor.aozoraInputDesc")}
        >
          <SettingToggle settingKey="editor.aozoraInput" defaultValue={true} />
        </SettingRow>
        <SettingRow
          label={t("settings.editor.autoPairBrackets")}
          description={t("settings.editor.autoPairBracketsDesc")}
        >
          <SettingToggle
            settingKey="editor.autoPairBrackets"
            defaultValue={true}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.editor.showInvisibles")}
          description={t("settings.editor.showInvisiblesDesc")}
        >
          <SettingToggle
            settingKey="editor.showInvisibles"
            defaultValue={false}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.editor.codexPopoverOnCaret")}
          description={t("settings.editor.codexPopoverOnCaretDesc")}
        >
          <SettingToggle
            settingKey="editor.codexPopoverOnCaret"
            defaultValue={false}
          />
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

      <SettingSection title={t("settings.editor.beats")}>
        <SettingRow
          label={t("settings.editor.focusModeHideBeats")}
          description={t("settings.editor.focusModeHideBeatsDesc")}
        >
          <SettingToggle
            settingKey="editor.focusModeHideBeats"
            defaultValue={false}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.editor.linearBeatDisplay")}
          description={t("settings.editor.linearBeatDisplayDesc")}
        >
          <SettingDropdown
            settingKey="editor.linearBeatDisplay"
            options={LINEAR_BEAT_DISPLAY_OPTIONS}
            defaultValue="collapsed"
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
        <SettingRow label={t("settings.editor.caretSlideDuration")}>
          <SettingSlider
            settingKey="editor.caretSlideDuration"
            min={40}
            max={200}
            step={10}
            defaultValue={80}
            format={(v) => `${v}ms`}
            disabled={disableAll || !smoothCaret}
          />
        </SettingRow>
        <SettingRow label={t("settings.editor.caretSlideSnappiness")}>
          <SettingSlider
            settingKey="editor.caretSlideSnappiness"
            min={0}
            max={100}
            step={5}
            defaultValue={50}
            disabled={disableAll || !smoothCaret}
          />
        </SettingRow>
        <SettingRow label={t("settings.editor.caretMotionPreview")}>
          <div className="flex items-center gap-2">
            <CaretSlideResetButton />
            <CaretMotionPreview disabled={disableAll || !smoothCaret} />
          </div>
        </SettingRow>
        <SettingRow label={t("settings.editor.fadeOut")}>
          <AnimToggle
            value={fadeOut}
            onChange={setFadeOut}
            disabled={disableAll}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.editor.writingGoal")}>
        <SettingRow
          label={t("settings.editor.dailyGoalDefault")}
          description={t("settings.editor.dailyGoalDefaultDesc")}
        >
          <SettingNumberInput
            settingKey="goal.dailyDefaultChars"
            min={0}
            step={100}
            defaultValue={0}
            unit={t("writingStats.charsUnit")}
            placeholder={t("settings.editor.dailyGoalNone")}
          />
        </SettingRow>
      </SettingSection>

      <SettingScopeHeader title={t("settings.scopeProject")} />
      <SettingSection title={t("settings.editor.writingGoal")}>
        <SettingRow
          label={t("settings.editor.dailyGoal")}
          description={t("settings.editor.dailyGoalDesc")}
        >
          <SettingNumberInput
            settingKey="goal.dailyChars"
            min={0}
            step={100}
            defaultValue={0}
            unit={t("writingStats.charsUnit")}
            placeholder={t("settings.editor.dailyGoalInherit")}
          />
        </SettingRow>
      </SettingSection>
      <SettingSection title={t("settings.editor.writingDirection")}>
        <SettingRow
          label={t("settings.editor.verticalMode")}
          description={t("settings.editor.verticalModeDesc")}
        >
          <SettingToggle
            settingKey="editor.verticalMode"
            defaultValue={false}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.editor.tateChuYoko")}
          description={t("settings.editor.tateChuYokoDesc")}
        >
          <SettingDropdown
            settingKey="editor.tateChuYoko"
            options={TATE_CHU_YOKO_OPTIONS}
            defaultValue="2"
          />
        </SettingRow>
      </SettingSection>
      <SettingSection title={t("settings.editor.paragraphStyle")}>
        <SettingRow
          label={t("settings.editor.paragraphIndent")}
          description={t("settings.editor.paragraphIndentDesc")}
        >
          <SettingDropdown
            settingKey="editor.paragraphIndent"
            options={PARAGRAPH_INDENT_OPTIONS}
            defaultValue="0"
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
        <SettingRow
          label={t("settings.editor.textAutospace")}
          description={t("settings.editor.textAutospaceDesc")}
        >
          <SettingDropdown
            settingKey="editor.textAutospace"
            options={TEXT_AUTOSPACE_OPTIONS}
            defaultValue="normal"
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
  return <Switch checked={value} onCheckedChange={onChange} />;
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
    <Switch checked={value} onCheckedChange={onChange} disabled={disabled} />
  );
}
