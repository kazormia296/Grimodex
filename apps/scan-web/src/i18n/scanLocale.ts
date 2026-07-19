export const SCAN_LOCALE_STORAGE_KEY = "grimodex:scan-ui-language";

export type ScanLocale = "ja" | "en";
export type ScanLocalePreference = "auto" | ScanLocale;
export type ScanWritingLanguagePreference = "auto" | ScanLocale;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isLocalePreference(value: unknown): value is ScanLocalePreference {
  return value === "auto" || value === "ja" || value === "en";
}

export function resolveScanLocale(
  preference: ScanLocalePreference,
  browserLanguages: readonly string[],
): ScanLocale {
  if (preference !== "auto") return preference;
  for (const language of browserLanguages) {
    const primary = language.trim().toLowerCase().split("-", 1)[0];
    if (primary === "ja" || primary === "en") return primary;
  }
  return "ja";
}

export function readScanLocalePreference(
  storage: Pick<StorageLike, "getItem"> | null | undefined,
): ScanLocalePreference {
  if (!storage) return "auto";
  try {
    const value = storage.getItem(SCAN_LOCALE_STORAGE_KEY);
    return isLocalePreference(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

export function writeScanLocalePreference(
  preference: ScanLocalePreference,
  storage: Pick<StorageLike, "setItem"> | null | undefined,
): void {
  if (!storage || !isLocalePreference(preference)) return;
  try {
    storage.setItem(SCAN_LOCALE_STORAGE_KEY, preference);
  } catch {
    // Language switching remains available for this tab when storage is blocked.
  }
}

export function currentBrowserLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  if (navigator.languages.length > 0) return [...navigator.languages];
  return navigator.language ? [navigator.language] : [];
}
