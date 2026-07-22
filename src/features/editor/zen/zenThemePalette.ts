import { useMemo, useSyncExternalStore } from "react";
import { useWorkspaceStore } from "@/features/workspace/store";
import {
  COLOR_THEMES,
  DEFAULT_COLOR_THEME,
  type ThemePalette,
} from "@/lib/colorThemes";
import type { ZenResolvedPalette } from "./zenShaderConfig";

const FALLBACK_PALETTE: ZenResolvedPalette = {
  background: "#101318",
  colors: ["#8fb4d6", "#d6b5a5", "#786fa6", "#d8c47c"],
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

/** Convert modern CSS colors (including oklch) to Paper's rgba parser format. */
function toPaperColor(cssColor: string, fallback: string): string {
  if (/^#[\da-f]{3,8}$/i.test(cssColor)) return cssColor;
  if (typeof document === "undefined") return fallback;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return fallback;
  try {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = cssColor;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    if (a === 0 && !/transparent|\/\s*0(?:\.0+)?\s*\)/i.test(cssColor)) {
      return fallback;
    }
    return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  } catch {
    return fallback;
  }
}

function paletteFromTheme(theme: ThemePalette): ZenResolvedPalette {
  return {
    background: toPaperColor(
      theme["--content-background"],
      FALLBACK_PALETTE.background,
    ),
    colors: [
      toPaperColor(theme["--glass-tint-a"], FALLBACK_PALETTE.colors[0]),
      toPaperColor(theme["--glass-tint-b"], FALLBACK_PALETTE.colors[1]),
      toPaperColor(theme["--content-accent"], FALLBACK_PALETTE.colors[2]),
      toPaperColor(theme["--primary"], FALLBACK_PALETTE.colors[3]),
    ],
  };
}

export function useZenThemePalette(): ZenResolvedPalette {
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
