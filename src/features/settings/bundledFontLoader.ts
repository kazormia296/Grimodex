import { useSettingsStore } from "./settingsStore";

type BundledFontFamily =
  | "Noto Serif JP"
  | "M PLUS 1"
  | "LINE Seed JP"
  | "Gen Interface JP"
  | "Literata";

const loaders: Record<BundledFontFamily, () => Promise<unknown>> = {
  "Noto Serif JP": () => import("./fontLoaders/notoSerifJp"),
  "M PLUS 1": () => import("./fontLoaders/mPlus1"),
  "LINE Seed JP": () => import("./fontLoaders/lineSeedJp"),
  "Gen Interface JP": () => import("./fontLoaders/genInterfaceJp"),
  Literata: () => import("./fontLoaders/literata"),
};

const BUNDLED_FONT_SETTING_KEYS = [
  "display.uiFontFamily",
  "editor.fontFamily",
  "codex.entryTitleFont",
] as const;

const loaded = new Set<BundledFontFamily>();
const loading = new Map<BundledFontFamily, Promise<unknown>>();

export function bundledFontFamilyFromCssValue(
  cssValue: string,
): BundledFontFamily | null {
  for (const family of Object.keys(loaders) as BundledFontFamily[]) {
    const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|["'\\s,])${escaped}(?:$|["'\\s,])`).test(cssValue)) {
      return family;
    }
  }
  return null;
}

export function loadBundledFontForCssValue(
  cssValue: string,
): Promise<unknown> | null {
  const family = bundledFontFamilyFromCssValue(cssValue);
  if (!family || loaded.has(family)) return null;
  const existing = loading.get(family);
  if (existing) return existing;
  const request = loaders[family]()
    .then((result) => {
      loaded.add(family);
      return result;
    })
    .finally(() => {
      loading.delete(family);
    });
  loading.set(family, request);
  return request;
}

type FontLoadRequest = (cssValue: string) => Promise<unknown> | null;

function loadSelectedFonts(
  loadFont: FontLoadRequest,
  keys: readonly (typeof BUNDLED_FONT_SETTING_KEYS)[number][],
): void {
  const settings = useSettingsStore.getState();
  for (const key of keys) {
    void loadFont(settings.get(key))?.catch(() => {
      // CSS chunk failures fall back to the configured system font stack.
    });
  }
}

/**
 * Load only the currently selected bundled families after settings hydration.
 * Before `loadAll()` completes, the cache contains DEFAULT_SETTINGS rather than
 * the persisted selection; importing those defaults would needlessly download
 * them before immediately loading a saved custom family. Later picker changes
 * (including the Codex entry-title font) remain independently observable.
 */
export function installSelectedBundledFontLoading(
  loadFont: FontLoadRequest = loadBundledFontForCssValue,
): () => void {
  if (useSettingsStore.getState().isLoaded) {
    loadSelectedFonts(loadFont, BUNDLED_FONT_SETTING_KEYS);
  }
  return useSettingsStore.subscribe((state, previous) => {
    if (!state.isLoaded) return;
    const keys = previous.isLoaded
      ? BUNDLED_FONT_SETTING_KEYS.filter(
          (key) => state.cache[key] !== previous.cache[key],
        )
      : BUNDLED_FONT_SETTING_KEYS;
    if (keys.length > 0) loadSelectedFonts(loadFont, keys);
  });
}
