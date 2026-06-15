import { describe, it, expect } from "vitest";
import { getPresetGroups } from "./exportPresetCatalog";
import { EXPORT_PRESET_IDS } from "./exportPresets";

// ────────────────────────────────────────────────────────────────────
// getPresetGroups — プロジェクト言語別の optgroup グルーピング
// ────────────────────────────────────────────────────────────────────

describe("getPresetGroups", () => {
  it("en プロジェクト: primary に英語プリセット、secondary に日本語サイト", () => {
    const g = getPresetGroups("en");
    expect(g.primary.ids).toEqual(["web-fiction", "ao3"]);
    expect(g.generic.ids).toEqual(["generic-md", "word-html"]);
    // 日本語サイトは末尾の「Japanese platforms」に集約（aozora 含む）
    expect(g.secondary.ids).toContain("narou");
    expect(g.secondary.ids).toContain("aozora");
    expect(g.secondary.labelKey).toBe(
      "export.settings.preset.japanesePlatformsGroup",
    );
  });

  it("ja プロジェクト: primary に日本語サイト、secondary に英語プリセット", () => {
    const g = getPresetGroups("ja");
    expect(g.primary.ids).toContain("narou");
    // aozora は generic グループ側（既存挙動の維持）
    expect(g.primary.ids).not.toContain("aozora");
    expect(g.generic.ids).toContain("aozora");
    expect(g.generic.ids).toContain("generic-md");
    expect(g.secondary.ids).toEqual(["web-fiction", "ao3"]);
    expect(g.secondary.labelKey).toBe(
      "export.settings.preset.englishPlatformsGroup",
    );
  });

  it("未知の projectLanguage は ja 扱い（フォールバック）", () => {
    const g = getPresetGroups("fr");
    expect(g.primary.ids).toContain("narou");
    expect(g.secondary.ids).toEqual(["web-fiction", "ao3"]);
  });

  it("現在選択が narou の英語プロジェクトでも narou が options に含まれる", () => {
    const g = getPresetGroups("en", "narou");
    const all = [...g.primary.ids, ...g.generic.ids, ...g.secondary.ids];
    expect(all).toContain("narou");
  });

  it("全ビルトインプリセットがいずれかのグループに必ず含まれる", () => {
    for (const lang of ["ja", "en"]) {
      const g = getPresetGroups(lang);
      const all = [...g.primary.ids, ...g.generic.ids, ...g.secondary.ids];
      for (const id of EXPORT_PRESET_IDS) {
        if (id === "custom") continue;
        expect(all).toContain(id);
      }
    }
  });

  it("primary は常に builtinGroup、generic は常に genericGroup ラベル", () => {
    for (const lang of ["ja", "en"]) {
      const g = getPresetGroups(lang);
      expect(g.primary.labelKey).toBe("export.settings.preset.builtinGroup");
      expect(g.generic.labelKey).toBe("export.settings.preset.genericGroup");
    }
  });
});
