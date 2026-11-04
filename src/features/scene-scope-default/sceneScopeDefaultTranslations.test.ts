import { describe, expect, it } from "vitest";
import i18next from "@/lib/i18n";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ensureSceneScopeDefaultTranslations,
  SCENE_SCOPE_DEFAULT_TRANSLATIONS,
} from "./sceneScopeDefaultTranslations";

// Read the files themselves: i18next deep-merges added bundles into the
// imported JSON objects at runtime.
const locale = (name: string) =>
  JSON.parse(
    readFileSync(path.resolve("src/locales", `${name}.json`), "utf8"),
  ) as {
    settings: { project: Record<string, string> };
    import: Record<string, unknown>;
    relatedScenes: Record<string, string>;
    editor: { sceneDetail: Record<string, string> };
  };
const ja = locale("ja");
const en = locale("en");

describe("scene scope default translations（DR-SDEF-52）", () => {
  it("keep the lazy screens' strings out of the startup locale files", () => {
    for (const file of [ja, en]) {
      expect(
        Object.keys(file.settings.project).filter((key) =>
          key.startsWith("sceneScope"),
        ),
      ).toEqual([]);
      expect(
        Object.keys(file.import).filter((key) => key.startsWith("sceneScope")),
      ).toEqual([]);
      expect(
        Object.keys(file.relatedScenes).filter((key) =>
          key.startsWith("scope"),
        ),
      ).toEqual([]);
    }
    // The Scope field's own strings stay in the startup files.
    expect(ja.editor.sceneDetail).toHaveProperty("scopeDefaultBadge");
  });

  it("has the same keys in ja and en", () => {
    const keys = (value: unknown, prefix = ""): string[] =>
      value !== null && typeof value === "object"
        ? Object.entries(value).flatMap(([key, child]) =>
            keys(child, `${prefix}${key}.`),
          )
        : [prefix.slice(0, -1)];
    const { ja: jaStrings, en: enStrings } = SCENE_SCOPE_DEFAULT_TRANSLATIONS;
    expect(keys(enStrings).sort()).toEqual(keys(jaStrings).sort());
    expect(keys(jaStrings).length).toBeGreaterThan(0);
  });

  it("register both locales without replacing existing resources", () => {
    const existing = i18next.getResource(
      "ja",
      "translation",
      "settings.project.title",
    );
    ensureSceneScopeDefaultTranslations();
    expect(
      i18next.getResource(
        "ja",
        "translation",
        "settings.project.sceneScopeApplyUnset",
      ),
    ).toBe("未設定の場面に既定を当てる");
    expect(
      i18next.getResource("en", "translation", "relatedScenes.scopeApplied"),
    ).toContain("next time");
    expect(
      i18next.getResource("ja", "translation", "settings.project.title"),
    ).toBe(existing);
  });
});
