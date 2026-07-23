import { useMemo, useSyncExternalStore } from "react";
import { getShaderColorFromString } from "@paper-design/shaders";
import { useWorkspaceStore } from "@/features/workspace/store";
import {
  COLOR_THEMES,
  DEFAULT_COLOR_THEME,
  type ThemePalette,
} from "@/lib/colorThemes";
import type { ZenResolvedPalette } from "./zenShaderConfig";

export interface ZenThemePalette extends ZenResolvedPalette {
  textColor: [number, number, number];
  backdropColor: [number, number, number];
}

const FALLBACK_PALETTE: ZenThemePalette = {
  background: "#101318",
  colors: ["#8fb4d6", "#d6b5a5", "#786fa6", "#d8c47c"],
  textColor: [0.85, 0.85, 0.85],
  backdropColor: [0.063, 0.075, 0.094],
};

function subscribeSystemTheme(onChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function systemPrefersDark() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

const CSS_NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
const OKLCH_PATTERN = new RegExp(
  `^oklch\\(\\s*(${CSS_NUMBER})(%)?\\s+(${CSS_NUMBER})(%)?\\s+(${CSS_NUMBER})(?:deg)?(?:\\s*\\/\\s*(${CSS_NUMBER})(%)?)?\\s*\\)$`,
  "i",
);

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

function linearToSrgb(value: number) {
  return clamp(
    value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055,
  );
}

/** Convert static theme colors to Paper's rgba format without canvas readback. */
export function normalizeZenThemeColor(
  cssColor: string,
  fallback: string,
): string {
  if (/^#[\da-f]{3,8}$/i.test(cssColor) || /^(?:rgb|hsl)a?\(/i.test(cssColor)) {
    return cssColor;
  }

  const match = cssColor.match(OKLCH_PATTERN);
  if (!match) return fallback;
  const lightness = clamp(Number(match[1]) * (match[2] === "%" ? 0.01 : 1));
  const chroma = Math.max(0, Number(match[3]) * (match[4] === "%" ? 0.004 : 1));
  const hue = (Number(match[5]) * Math.PI) / 180;
  const alpha = clamp(
    match[6] === undefined
      ? 1
      : Number(match[6]) * (match[7] === "%" ? 0.01 : 1),
  );
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const red = linearToSrgb(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
  );
  const green = linearToSrgb(
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
  );
  const blue = linearToSrgb(
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  );

  return `rgba(${Math.round(red * 255)}, ${Math.round(green * 255)}, ${Math.round(blue * 255)}, ${Number(alpha.toFixed(4))})`;
}

function rgb(color: string): [number, number, number] {
  const [red, green, blue] = getShaderColorFromString(color);
  return [red, green, blue];
}

function paletteFromTheme(theme: ThemePalette): ZenThemePalette {
  const background = normalizeZenThemeColor(
    theme["--content-background"],
    FALLBACK_PALETTE.background,
  );
  const backdrop = normalizeZenThemeColor(theme["--background"], background);
  const text = normalizeZenThemeColor(
    theme["--content-foreground-secondary"],
    "#d9d9d9",
  );
  return {
    background,
    colors: [
      normalizeZenThemeColor(
        theme["--glass-tint-a"],
        FALLBACK_PALETTE.colors[0],
      ),
      normalizeZenThemeColor(
        theme["--glass-tint-b"],
        FALLBACK_PALETTE.colors[1],
      ),
      normalizeZenThemeColor(
        theme["--content-accent"],
        FALLBACK_PALETTE.colors[2],
      ),
      normalizeZenThemeColor(theme["--primary"], FALLBACK_PALETTE.colors[3]),
    ],
    textColor: rgb(text),
    backdropColor: rgb(backdrop),
  };
}

export function useZenThemePalette(): ZenThemePalette {
  const themeMode = useWorkspaceStore(
    (state) => state.globalSettings?.theme ?? "system",
  );
  const colorTheme = useWorkspaceStore(
    (state) => state.globalSettings?.colorTheme ?? DEFAULT_COLOR_THEME,
  );
  const prefersDark = useSyncExternalStore(
    subscribeSystemTheme,
    systemPrefersDark,
    () => false,
  );

  return useMemo(() => {
    const definition =
      COLOR_THEMES.find((theme) => theme.id === colorTheme) ??
      COLOR_THEMES.find((theme) => theme.id === DEFAULT_COLOR_THEME);
    if (!definition) return FALLBACK_PALETTE;
    const dark =
      themeMode === "dark" || (themeMode === "system" && prefersDark);
    return paletteFromTheme(dark ? definition.dark : definition.light);
  }, [colorTheme, prefersDark, themeMode]);
}
