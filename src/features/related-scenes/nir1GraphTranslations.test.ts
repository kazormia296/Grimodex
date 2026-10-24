import { describe, expect, it } from "vitest";
import i18next from "@/lib/i18n";
import en from "@/locales/en.json";
import ja from "@/locales/ja.json";
import {
  NIR1_GRAPH_TRANSLATIONS,
  ensureNir1GraphTranslations,
} from "./nir1GraphTranslations";

const keys = (value: object, prefix = ""): string[] =>
  Object.entries(value).flatMap(([key, child]) =>
    typeof child === "object" && child !== null
      ? keys(child, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );

describe("Related Scenes Graph translations", () => {
  it("have the same keys in ja and en", () => {
    expect(keys(NIR1_GRAPH_TRANSLATIONS.ja).sort()).toEqual(
      keys(NIR1_GRAPH_TRANSLATIONS.en).sort(),
    );
  });

  it("are not in the startup locale files (DR-CP3B-7)", () => {
    expect(ja.relatedScenes).not.toHaveProperty("graph");
    expect(en.relatedScenes).not.toHaveProperty("graph");
  });

  it("register both locales without replacing existing resources", () => {
    const existing = i18next.getResource(
      "ja",
      "translation",
      "relatedScenes.empty",
    );
    expect(existing).toBeTruthy();

    ensureNir1GraphTranslations();

    expect(
      i18next.getResource(
        "ja",
        "translation",
        "relatedScenes.graph.pathHeading",
      ),
    ).toBe("Graph の経路");
    expect(
      i18next.getResource(
        "en",
        "translation",
        "relatedScenes.graph.pathHeading",
      ),
    ).toBe("Graph path");
    expect(
      i18next.getResource("ja", "translation", "relatedScenes.empty"),
    ).toBe(existing);
    expect(i18next.getResource("en", "translation", "relatedScenes.rank")).toBe(
      en.relatedScenes.rank,
    );
  });
});
