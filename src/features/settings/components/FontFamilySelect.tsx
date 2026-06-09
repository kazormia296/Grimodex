import { useTranslation } from "react-i18next";
import { useSettingControl } from "../useSettingControl";
import { useSystemFonts } from "../hooks/useSystemFonts";
import {
  buildFontOptions,
  type FontOption,
  type FontOptionGroup,
} from "../buildFontOptions";
import { BUNDLED_FONTS } from "../bundledFonts";

interface FontFamilySelectProps {
  settingKey: string;
  defaultValue?: string;
}

/** optgroup の表示順。current（移行注入）を先頭に、長いシステム一覧を末尾に。 */
const GROUP_ORDER: FontOptionGroup[] = [
  "current",
  "basic",
  "bundled",
  "system",
];

/**
 * エディタ本文フォントの選択コントロール。
 *
 * - システム列挙フォント（`useSystemFonts`）＋ビルトイン＋同梱を `buildFontOptions`
 *   でマージし、グループ別 optgroup で表示する。
 * - 選択中フォントのライブプレビューを下に出す（`<option>` 自体のフォント指定は
 *   WebKit で不安定なため別要素でプレビューする）。
 *
 * 注意: 列挙したフォント名が実際に webview で解決されるか（プレビュー／本文に
 * 反映されるか）は実機 macOS/Windows でのみ確認できる。
 */
export function FontFamilySelect({
  settingKey,
  defaultValue = '"Noto Serif JP"',
}: FontFamilySelectProps) {
  const { t } = useTranslation();
  const { value, setValue } = useSettingControl(settingKey, defaultValue);
  const systemFonts = useSystemFonts();

  const options = buildFontOptions({
    systemFonts,
    bundledFonts: BUNDLED_FONTS,
    storedValue: value,
    labels: {
      basicDefault: t("settings.editor.fontDefault"),
      basicMono: t("settings.editor.fontMono"),
    },
  });

  const groupLabels: Record<FontOptionGroup, string> = {
    current: t("settings.editor.fontCurrentGroup"),
    basic: t("settings.editor.fontBasicGroup"),
    bundled: t("settings.editor.fontBundledGroup"),
    system: t("settings.editor.fontSystemGroup"),
  };

  const grouped = GROUP_ORDER.map((group) => ({
    group,
    items: options.filter((o) => o.group === group),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col items-end gap-2">
      <select
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="max-w-[16rem] rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
      >
        {grouped.map(({ group, items }) => (
          <optgroup key={group} label={groupLabels[group]}>
            {items.map((o: FontOption) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <div
        aria-hidden
        className="w-full max-w-[16rem] truncate rounded-md border border-input/60 bg-muted/30 px-2 py-1 text-sm text-muted-foreground"
        style={{ fontFamily: value }}
        title={t("settings.editor.fontPreviewSample")}
      >
        {t("settings.editor.fontPreviewSample")}
      </div>
    </div>
  );
}
