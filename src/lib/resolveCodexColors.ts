import { COLOR_THEMES, DEFAULT_COLOR_THEME, PALETTE_SIZE } from "./colorThemes";

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
