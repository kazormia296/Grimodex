import { useTranslation } from "react-i18next";
import { useSettingControl } from "../useSettingControl";
import { useSystemFonts } from "../hooks/useSystemFonts";
import {
  buildFontOptions,
  type BundledFont,
  type FontOption,
  type FontOptionGroup,
} from "../buildFontOptions";
import { BUNDLED_FONTS } from "../bundledFonts";

interface FontFamilySelectProps {
  settingKey: string;
  defaultValue?: string;
  /**
   * このピッカー固有の追加同梱フォント。共通の BUNDLED_FONTS（本文/UI 用）に
   * 混ぜず、ここで渡したものだけ「同梱」グループに足す。例: Codex タイトル用の
   * 表示フォント（駅名標 / Helvetica 系）を Codex 設定のみで選べるようにする。
   */
  extraBundledFonts?: BundledFont[];
  /**
   * basic グループ先頭「デフォルト」選択肢の値。既定は CSS generic "serif"。
   * Codex のように「デフォルト＝言語別の既定に追従」を表したい場合は "" を渡す。
   */
  defaultOptionValue?: string;
  /**
   * 「デフォルト」選択肢のラベル。未指定なら "デフォルト (serif)"。Codex では
   * "デフォルト (Toaru Eki Sign)" のように実フォント名を入れる。
   */
  defaultOptionLabel?: string;
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
  extraBundledFonts,
  defaultOptionValue,
  defaultOptionLabel,
}: FontFamilySelectProps) {
  const { t } = useTranslation();
  const { value, setValue } = useSettingControl(settingKey, defaultValue);
  const systemFonts = useSystemFonts();

  // 「デフォルト」が空センチネル ("") のピッカー(Codex)では value をそのまま使い、
  // basic 先頭の空値オプションに一致させる。プレビューだけは空のとき defaultValue に
  // 落として実フォントを描く。
  const previewValue = value.trim() || defaultValue;

  const options = buildFontOptions({
    systemFonts,
    bundledFonts: extraBundledFonts
      ? [...BUNDLED_FONTS, ...extraBundledFonts]
      : BUNDLED_FONTS,
    storedValue: value,
    labels: {
      basicDefault: defaultOptionLabel ?? t("settings.editor.fontDefault"),
      basicMono: t("settings.editor.fontMono"),
    },
    defaultOptionValue,
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
        style={{ fontFamily: previewValue }}
        title={t("settings.editor.fontPreviewSample")}
      >
        {t("settings.editor.fontPreviewSample")}
      </div>
    </div>
  );
}
