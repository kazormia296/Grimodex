import { describe, it, expect } from "vitest";
import { buildFontOptions } from "./buildFontOptions";
import { BUNDLED_FONTS } from "./bundledFonts";
import { DEFAULT_SETTINGS } from "./types";

const labels = { basicDefault: "Default", basicMono: "Mono" };

/**
 * 同梱フォントをデフォルトにするピッカーは、その既定値が buildFontOptions の
 * 同梱 option value と**バイト一致**していなければならない。ズレると <select> が
 * 空欄化するか、移行注入で二重表示になる（本文/UI 両方で再発しやすい罠）。
 */
describe("bundled font defaults stay selectable", () => {
  it("editor.fontFamily / display.uiFontFamily defaults each match a bundled option value", () => {
    const opts = buildFontOptions({
      systemFonts: [],
      bundledFonts: BUNDLED_FONTS,
      storedValue: "",
      labels,
    });
    for (const key of ["editor.fontFamily", "display.uiFontFamily"] as const) {
      const def = DEFAULT_SETTINGS[key];
      const match = opts.find((o) => o.value === def);
      expect(
        match,
        `${key}=${def} must be a selectable bundled option`,
      ).toBeTruthy();
      expect(match?.group).toBe("bundled");
    }
  });

  it("bundles both a body (mincho) and a UI (gothic) face", () => {
    expect(BUNDLED_FONTS.length).toBeGreaterThanOrEqual(2);
    const families = BUNDLED_FONTS.map((f) => f.family);
    expect(families).toContain("Noto Serif JP");
    expect(families).toContain("M PLUS 1");
  });
});
