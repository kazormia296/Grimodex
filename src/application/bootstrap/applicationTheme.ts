import {
  COLOR_THEMES,
  DEFAULT_COLOR_THEME,
  THEME_CSS_VARS,
} from "@/lib/colorThemes";

export function applyApplicationTheme(
  theme: string,
  colorTheme?: string,
): void {
  const html = document.documentElement;
  if (theme === "dark") {
    html.classList.add("dark");
  } else if (theme === "light") {
    html.classList.remove("dark");
  } else {
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    html.classList.toggle("dark", prefersDark);
  }

  const themeDefinition = COLOR_THEMES.find(
    (candidate) => candidate.id === (colorTheme ?? DEFAULT_COLOR_THEME),
  );
  if (!themeDefinition) {
    for (const property of THEME_CSS_VARS) {
      html.style.removeProperty(property);
    }
    return;
  }

  const palette = html.classList.contains("dark")
    ? themeDefinition.dark
    : themeDefinition.light;
  for (const property of THEME_CSS_VARS) {
    html.style.setProperty(property, palette[property]);
  }
}
