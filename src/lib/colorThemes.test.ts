import { describe, it, expect } from "vitest";
import {
  COLOR_THEMES,
  THEME_CSS_VARS,
  DEFAULT_COLOR_THEME,
} from "./colorThemes";

describe("colorThemes", () => {
  it("DEFAULT_COLOR_THEME references a valid theme", () => {
    const theme = COLOR_THEMES.find((t) => t.id === DEFAULT_COLOR_THEME);
    expect(theme).toBeDefined();
  });

  for (const theme of COLOR_THEMES) {
    describe(`theme "${theme.id}"`, () => {
      it("light palette has all THEME_CSS_VARS keys", () => {
        for (const varName of THEME_CSS_VARS) {
          expect(theme.light).toHaveProperty(varName);
          expect(typeof theme.light[varName]).toBe("string");
          expect(theme.light[varName].length).toBeGreaterThan(0);
        }
      });

      it("dark palette has all THEME_CSS_VARS keys", () => {
        for (const varName of THEME_CSS_VARS) {
          expect(theme.dark).toHaveProperty(varName);
          expect(typeof theme.dark[varName]).toBe("string");
          expect(theme.dark[varName].length).toBeGreaterThan(0);
        }
      });

      it("light palette includes content zone variables", () => {
        expect(theme.light["--content-background"]).toBeDefined();
        expect(theme.light["--content-foreground"]).toBeDefined();
        expect(theme.light["--content-foreground-secondary"]).toBeDefined();
        expect(theme.light["--content-foreground-muted"]).toBeDefined();
        expect(theme.light["--content-accent"]).toBeDefined();
        expect(theme.light["--content-border"]).toBeDefined();
      });

      it("dark palette includes content zone variables", () => {
        expect(theme.dark["--content-background"]).toBeDefined();
        expect(theme.dark["--content-foreground"]).toBeDefined();
        expect(theme.dark["--content-foreground-secondary"]).toBeDefined();
        expect(theme.dark["--content-foreground-muted"]).toBeDefined();
        expect(theme.dark["--content-accent"]).toBeDefined();
        expect(theme.dark["--content-border"]).toBeDefined();
      });
    });
  }
});
