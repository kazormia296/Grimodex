import { describe, expect, it } from "vitest";
import i18next from "@/lib/i18n";
import en from "@/locales/en.json";
import ja from "@/locales/ja.json";
import { ensureBodyDeclarationTranslations } from "./bodyDeclarationTranslations";

describe("body declaration translations", () => {
  it("are not in the startup locale files (DR-CB3-35)", () => {
    expect(ja.editor.sceneDetail).not.toHaveProperty("bodyDeclaration");
    expect(en.editor.sceneDetail).not.toHaveProperty("bodyDeclaration");
  });

  it("register both locales without replacing existing resources", () => {
    const existing = i18next.getResource(
      "ja",
      "translation",
      "editor.sceneDetail.beatsChip",
    );

    ensureBodyDeclarationTranslations();

    expect(
      i18next.getResource(
        "ja",
        "translation",
        "editor.sceneDetail.bodyDeclaration.state.effective",
      ),
    ).toBe("宣言済み・現在有効");
    expect(
      i18next.getResource(
        "en",
        "translation",
        "editor.sceneDetail.bodyDeclaration.state.effective",
      ),
    ).toBe("Declared, currently effective");
    expect(
      i18next.getResource("ja", "translation", "editor.sceneDetail.beatsChip"),
    ).toBe(existing);
  });
});
