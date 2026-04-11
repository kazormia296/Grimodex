import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingToggle } from "../components/SettingToggle";
import { SettingSlider } from "../components/SettingSlider";
import { SettingDropdown } from "../components/SettingDropdown";
import { useSettingBoolean } from "../useSettingControl";

const WORD_BREAK_OPTIONS = [
  { value: "auto-phrase", label: "語句優先 (auto-phrase)" },
  { value: "normal", label: "標準 (normal)" },
  { value: "break-all", label: "どこでも改行 (break-all)" },
  { value: "keep-all", label: "単語優先 (keep-all)" },
];

const LINE_BREAK_OPTIONS = [
  { value: "strict", label: "厳密 (strict)" },
  { value: "normal", label: "標準 (normal)" },
  { value: "loose", label: "ゆるい (loose)" },
  { value: "auto", label: "自動 (auto)" },
];

const FONT_FAMILY_OPTIONS = [
  { value: "serif", label: "デフォルト (serif)" },
  { value: '"Noto Serif JP", serif', label: "Noto Serif JP" },
  { value: '"Noto Sans JP", sans-serif', label: "Noto Sans JP" },
  { value: '"BIZ UDMincho", serif', label: "BIZ UDMincho" },
  { value: '"BIZ UDGothic", sans-serif', label: "BIZ UDGothic" },
  { value: '"Source Han Serif JP", serif', label: "Source Han Serif" },
  { value: "monospace", label: "等幅フォント" },
];

export function EditorCategory() {
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
      <SettingSection title="テキスト表示">
        <SettingRow label="フォント">
          <SettingDropdown
            settingKey="editor.fontFamily"
            options={FONT_FAMILY_OPTIONS}
            defaultValue="serif"
          />
        </SettingRow>
        <SettingRow label="フォントサイズ">
          <SettingSlider
            settingKey="editor.fontSize"
            min={14}
            max={24}
            step={1}
            defaultValue={18}
            format={(v) => `${v}px`}
          />
        </SettingRow>
        <SettingRow label="行間">
          <SettingSlider
            settingKey="editor.lineHeight"
            min={1.2}
            max={3.0}
            step={0.1}
            defaultValue={2.0}
            format={(v) => v.toFixed(1)}
          />
        </SettingRow>
        <SettingRow label="最大コンテンツ幅">
          <SettingSlider
            settingKey="editor.maxContentWidth"
            min={480}
            max={960}
            step={40}
            defaultValue={720}
            format={(v) => `${v}px`}
          />
        </SettingRow>
        <SettingRow label="段落間隔">
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
          label="単語の折り返し"
          description="行末での単語・語句の折り返し方法"
        >
          <SettingDropdown
            settingKey="editor.wordBreak"
            options={WORD_BREAK_OPTIONS}
            defaultValue="normal"
          />
        </SettingRow>
        <SettingRow
          label="禁則処理"
          description="行頭・行末に置けない文字のルール（日本語）"
        >
          <SettingDropdown
            settingKey="editor.lineBreak"
            options={LINE_BREAK_OPTIONS}
            defaultValue="strict"
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title="編集体験">
        <SettingRow
          label="タイプライターモード"
          description="カーソル行を常に画面中央に固定"
        >
          <SettingToggle
            settingKey="editor.typewriterMode"
            defaultValue={false}
          />
        </SettingRow>
        <SettingRow
          label="自動保存間隔"
          description="入力停止後に保存するまでの時間"
        >
          <SettingSlider
            settingKey="editor.autoSaveDelay"
            min={500}
            max={10000}
            step={500}
            defaultValue={2000}
            format={(v) => `${v / 1000}秒`}
          />
        </SettingRow>
        <SettingRow label="スペルチェック">
          <SettingToggle settingKey="editor.spellCheck" defaultValue={false} />
        </SettingRow>
        <SettingRow
          label="スマートクォート"
          description={`" → " " の自動変換（日本語ではOFF推奨）`}
        >
          <SettingToggle settingKey="editor.smartQuotes" defaultValue={false} />
        </SettingRow>
        <SettingRow label="スマートダッシュ" description="-- → — の自動変換">
          <SettingToggle settingKey="editor.smartDashes" defaultValue={false} />
        </SettingRow>
      </SettingSection>

      <SettingSection title="インライン AI">
        <SettingRow label="/ コマンドを有効化">
          <SettingToggle
            settingKey="editor.inlineAiCommand"
            defaultValue={true}
          />
        </SettingRow>
        <SettingRow label="Ctrl+Shift+Space パレットを有効化">
          <SettingToggle
            settingKey="editor.inlineAiShortcut"
            defaultValue={true}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title="アニメーション">
        <SettingRow
          label="すべてのアニメーションを無効化"
          description="以下の設定を一括でOFF"
        >
          <DisableAllToggle value={disableAll} onChange={handleDisableAll} />
        </SettingRow>
        <SettingRow label="スムーズカーソル">
          <AnimToggle
            value={smoothCaret}
            onChange={setSmoothCaret}
            disabled={disableAll}
          />
        </SettingRow>
        <SettingRow label="カーソル点滅">
          <AnimToggle
            value={cursorBlink}
            onChange={setCursorBlink}
            disabled={disableAll}
          />
        </SettingRow>
        <SettingRow label="文字フェードイン">
          <AnimToggle
            value={fadeIn}
            onChange={setFadeIn}
            disabled={disableAll}
          />
        </SettingRow>
        <SettingRow label="文字フェードアウト">
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
