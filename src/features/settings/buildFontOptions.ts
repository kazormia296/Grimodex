/**
 * フォント選択肢の組み立て（純関数）。
 *
 * - ビルトイン (generic serif / monospace)
 * - 同梱フォント (将来 commit でバイナリ同梱したもの)
 * - システム列挙フォント (Rust `list_system_fonts` 由来)
 * を1つの選択肢リストにマージする。
 *
 * 重要: 既存ユーザーが保存済みの `editor.fontFamily` 値（例
 * `'"Noto Serif JP", serif'`）が列挙結果に含まれない場合、その値を
 * `current` グループの選択肢として先頭に注入する。これをしないと
 * `<select>` の value がどの option とも一致せず空欄表示になる（移行リグレッション）。
 */

export type FontOptionGroup = "current" | "basic" | "bundled" | "system";

export interface FontOption {
  /** CSS `font-family` にそのまま入れる値 */
  value: string;
  label: string;
  group: FontOptionGroup;
}

export interface BundledFont {
  family: string;
  label?: string;
}

export interface BuildFontOptionsInput {
  /** Rust 列挙で得たシステムフォント family 名（正規化済み） */
  systemFonts: string[];
  /** 同梱フォント（commit1 では空） */
  bundledFonts?: BundledFont[];
  /** 現在保存されている editor.fontFamily の値 */
  storedValue: string;
  labels: { basicDefault: string; basicMono: string };
}

/** CSS の font-family 値（スタック可）から先頭の family を取り出し、引用符を除く。 */
function labelFromCssValue(value: string): string {
  const first = value.split(",")[0]?.trim() ?? value;
  return first.replace(/^["']|["']$/g, "");
}

/** 列挙された family 名を CSS 値（引用符付き）に変換する。 */
function quoteFamily(family: string): string {
  return `"${family}"`;
}

export function buildFontOptions(input: BuildFontOptionsInput): FontOption[] {
  const { systemFonts, bundledFonts = [], storedValue, labels } = input;

  const basic: FontOption[] = [
    { value: "serif", label: labels.basicDefault, group: "basic" },
    { value: "monospace", label: labels.basicMono, group: "basic" },
  ];

  const bundled: FontOption[] = bundledFonts.map((b) => ({
    value: quoteFamily(b.family),
    label: b.label ?? b.family,
    group: "bundled",
  }));

  // 既に他グループが占有している値は system から除外する（同梱との重複防止）。
  const claimed = new Set<string>([
    ...basic.map((o) => o.value),
    ...bundled.map((o) => o.value),
  ]);

  const system: FontOption[] = [];
  for (const name of systemFonts) {
    const value = quoteFamily(name);
    if (claimed.has(value)) continue;
    claimed.add(value);
    system.push({ value, label: name, group: "system" });
  }

  const ordered: FontOption[] = [...basic, ...bundled, ...system];

  // 移行セーフティ: 保存済み値がどの選択肢にも無ければ先頭に注入する。
  const trimmedStored = storedValue.trim();
  if (trimmedStored && !ordered.some((o) => o.value === trimmedStored)) {
    ordered.unshift({
      value: storedValue,
      label: labelFromCssValue(storedValue),
      group: "current",
    });
  }

  return ordered;
}
