import {
  COLOR_THEMES,
  DEFAULT_COLOR_THEME,
  PALETTE_SIZE,
  type PaletteSlot,
} from "./colorThemes";

export interface ResolvedCodexColor {
  hl: string; // highlight background
  tx: string; // text color on highlight background
  fg: string; // text-only foreground color
}

/**
 * Resolves a Codex type's display colors from its palette index and the active theme.
 * Falls back to a derived color triple when paletteIndex is null (legacy types).
 */
export function resolveCodexColor(
  paletteIndex: number | null,
  legacyColor: string,
  themeId: string | undefined,
  isDark: boolean,
): ResolvedCodexColor {
  if (paletteIndex === null) {
    // Legacy fallback: derive hl/tx/fg from the single hex color
    return { hl: legacyColor + "29", tx: legacyColor, fg: legacyColor };
  }

  const resolvedId = themeId ?? DEFAULT_COLOR_THEME;
  const theme = COLOR_THEMES.find((t) => t.id === resolvedId);
  if (!theme) {
    return { hl: legacyColor + "29", tx: legacyColor, fg: legacyColor };
  }

  const palette = isDark ? theme.palette.dark : theme.palette.light;
  const slot = palette[paletteIndex % PALETTE_SIZE];
  return { hl: slot.hl, tx: slot.tx, fg: slot.fg };
}

/**
 * Codexハイライト（背景スタイル）の背景色を濃度レベルから解決する。
 * レベルは 5〜25、既定 10 = パレット設計値 (hl) をそのまま使う。
 * 10 未満は hl を透明側へ薄め、10 超は fg を混ぜて濃くする —
 * 既定値で従来の見た目が完全に保存されるようにした2セグメント式。
 */
export function codexHighlightBackground(
  colors: ResolvedCodexColor,
  level: number,
): string {
  const clamped = Number.isFinite(level)
    ? Math.min(25, Math.max(5, level))
    : 10;
  if (clamped === 10) return colors.hl;
  if (clamped < 10) {
    return `color-mix(in srgb, ${colors.hl} ${clamped * 10}%, transparent)`;
  }
  return `color-mix(in srgb, ${colors.fg} ${(clamped - 10) * 2}%, ${colors.hl})`;
}

/**
 * 背景 hex 色に対して可読なテキスト色（濃 or 白）を返す。YIQ 輝度で判定。
 * 入力が #RRGGBB でない（CSS 変数など）場合は白を返す。
 * プロットスレッドのチップ（色付き背景に段階テキスト）の文字色決定に使う。
 */
export function contrastTextColor(bg: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 140 ? "#1a1a1a" : "#ffffff";
}

/**
 * アクティブなカラーテーマ × モード（light/dark）の Codex タイプ用パレット
 * スロット一覧（全 PALETTE_SIZE 個）を返す。未知テーマは既定テーマへフォールバック。
 * Codex タイプの色選択とプロットスレッドの色選択で同じパレットを共有するための入口。
 */
export function activeCodexPaletteSlots(
  themeId: string | undefined,
  isDark: boolean,
): PaletteSlot[] {
  const theme =
    COLOR_THEMES.find((t) => t.id === (themeId ?? DEFAULT_COLOR_THEME)) ??
    COLOR_THEMES.find((t) => t.id === DEFAULT_COLOR_THEME)!;
  return isDark ? theme.palette.dark : theme.palette.light;
}
