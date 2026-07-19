import { describe, expect, it, vi } from "vitest";
import {
  SCAN_LOCALE_STORAGE_KEY,
  readScanLocalePreference,
  resolveScanLocale,
  writeScanLocalePreference,
} from "./scanLocale";

describe("Scan locale resolution", () => {
  it("resolves auto from the first supported browser language", () => {
    expect(resolveScanLocale("auto", ["fr-FR", "en-US", "ja-JP"])).toBe(
      "en",
    );
    expect(resolveScanLocale("auto", ["ja-JP", "en-US"])).toBe("ja");
    expect(resolveScanLocale("auto", ["fr-FR"])).toBe("ja");
  });

  it("keeps an explicit Japanese or English choice independent of the browser", () => {
    expect(resolveScanLocale("ja", ["en-US"])).toBe("ja");
    expect(resolveScanLocale("en", ["ja-JP"])).toBe("en");
  });

  it("persists only allowlisted preferences and recovers invalid storage as auto", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };

    writeScanLocalePreference("en", storage);
    expect(values.get(SCAN_LOCALE_STORAGE_KEY)).toBe("en");
    expect(readScanLocalePreference(storage)).toBe("en");

    values.set(SCAN_LOCALE_STORAGE_KEY, "de");
    expect(readScanLocalePreference(storage)).toBe("auto");
  });
});
