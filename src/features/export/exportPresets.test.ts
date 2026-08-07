import { describe, it, expect } from "vitest";
import {
  EXPORT_PRESET_IDS,
  applyExportPreset,
  detectExportPreset,
  validateUserPresetName,
} from "./exportPresets";
import { DEFAULT_EXPORT_SETTINGS } from "./types";
import type { ExportPresetId, ExportSettings } from "./types";

// ────────────────────────────────────────────────────────────────────
// applyExportPreset — 完全上書きでの ExportSettings 生成
// ────────────────────────────────────────────────────────────────────

describe("applyExportPreset", () => {
  it("custom は現在値をそのまま返し exportPresetId=custom", () => {
    const result = applyExportPreset("custom", DEFAULT_EXPORT_SETTINGS);
    expect(result.exportPresetId).toBe("custom");
  });

  it("narou: plaintext + aozora ルビ + narou-emphasis-batch + asterisks", () => {
    const result = applyExportPreset("narou", DEFAULT_EXPORT_SETTINGS);
    expect(result.format).toBe("plaintext");
    expect(result.rubyStyle).toBe("aozora");
    expect(result.emphasisDotsStyle).toBe("narou-emphasis-batch");
    expect(result.sceneBreakStyle).toBe("asterisks");
    expect(result.narouEmphasisMode).toBe("batch");
    expect(result.exportPresetId).toBe("narou");
  });

  it("kakuyomu: plaintext + aozora-auto + double-angle + blank", () => {
    const result = applyExportPreset("kakuyomu", DEFAULT_EXPORT_SETTINGS);
    expect(result.format).toBe("plaintext");
    expect(result.rubyStyle).toBe("aozora-auto");
    expect(result.emphasisDotsStyle).toBe("double-angle");
    expect(result.sceneDivider).toBe("blank");
    expect(result.exportPresetId).toBe("kakuyomu");
  });

  it("pixiv: pixiv-chapter フォーマット + rb-bracket + custom [newpage] sceneBreak", () => {
    const result = applyExportPreset("pixiv", DEFAULT_EXPORT_SETTINGS);
    expect(result.format).toBe("plaintext");
    expect(result.folderHeading).toBe(true);
    expect(result.folderHeadingFormat).toBe("pixiv-chapter");
    expect(result.rubyStyle).toBe("rb-bracket");
    expect(result.emphasisDotsStyle).toBe("double-angle");
    expect(result.sceneBreakStyle).toBe("custom");
    expect(result.sceneBreakCustom).toBe("[newpage]");
    expect(result.pixivChapterNewpage).toBe(false);
    expect(result.exportPresetId).toBe("pixiv");
  });

  it("alphapolis / hameln / novelup / novelism: aozora + double-angle + blank", () => {
    for (const id of ["alphapolis", "hameln", "novelup", "novelism"] as const) {
      const result = applyExportPreset(id, DEFAULT_EXPORT_SETTINGS);
      expect(result.format).toBe("plaintext");
      expect(result.rubyStyle).toBe("aozora");
      expect(result.emphasisDotsStyle).toBe("double-angle");
      expect(result.sceneDivider).toBe("blank");
      expect(result.exportPresetId).toBe(id);
    }
  });

  it("新規 jp-double-angle サイト（solispia 等）も aozora + double-angle", () => {
    for (const id of [
      "solispia",
      "estar",
      "aipen",
      "sutekibungei",
      "caita",
      "noveland",
    ] as const) {
      const result = applyExportPreset(id, DEFAULT_EXPORT_SETTINGS);
      expect(result.format).toBe("plaintext");
      expect(result.rubyStyle).toBe("aozora");
      expect(result.emphasisDotsStyle).toBe("double-angle");
      expect(result.sceneDivider).toBe("blank");
      expect(result.exportPresetId).toBe(id);
    }
  });

  it("noveldays / noichigo / maho: aozora + 傍点ルビ代用（per-char）", () => {
    for (const id of ["noveldays", "noichigo", "maho"] as const) {
      const result = applyExportPreset(id, DEFAULT_EXPORT_SETTINGS);
      expect(result.format).toBe("plaintext");
      expect(result.rubyStyle).toBe("aozora");
      expect(result.emphasisDotsStyle).toBe("narou-emphasis-per-char");
      expect(result.exportPresetId).toBe(id);
    }
  });

  it("aozora: 青空文庫テキスト形式（｜《》+ ［＃傍点］）", () => {
    const result = applyExportPreset("aozora", DEFAULT_EXPORT_SETTINGS);
    expect(result.format).toBe("plaintext");
    expect(result.rubyStyle).toBe("aozora");
    expect(result.emphasisDotsStyle).toBe("aozora");
    expect(result.sceneDivider).toBe("blank2");
    expect(result.exportPresetId).toBe("aozora");
  });

  it("monogatary: ルビ・傍点とも除去（base + plain）", () => {
    const result = applyExportPreset("monogatary", DEFAULT_EXPORT_SETTINGS);
    expect(result.format).toBe("plaintext");
    expect(result.rubyStyle).toBe("base");
    expect(result.emphasisDotsStyle).toBe("plain");
    expect(result.exportPresetId).toBe("monogatary");
  });

  it("generic-md: markdown + parentheses + plain dots", () => {
    const result = applyExportPreset("generic-md", DEFAULT_EXPORT_SETTINGS);
    expect(result.format).toBe("markdown");
    expect(result.rubyStyle).toBe("parentheses");
    expect(result.emphasisDotsStyle).toBe("plain");
    expect(result.exportPresetId).toBe("generic-md");
  });

  it("word-html: html + html ruby + html dots", () => {
    const result = applyExportPreset("word-html", DEFAULT_EXPORT_SETTINGS);
    expect(result.format).toBe("html");
    expect(result.rubyStyle).toBe("html");
    expect(result.emphasisDotsStyle).toBe("html");
    expect(result.exportPresetId).toBe("word-html");
  });

  it("web-fiction: plaintext + base ルビ除去 + plain 傍点除去 + asterisks", () => {
    const result = applyExportPreset("web-fiction", DEFAULT_EXPORT_SETTINGS);
    expect(result.format).toBe("plaintext");
    expect(result.rubyStyle).toBe("base");
    expect(result.emphasisDotsStyle).toBe("plain");
    expect(result.sceneBreakStyle).toBe("asterisks");
    expect(result.sceneDivider).toBe("blank");
    expect(result.folderHeading).toBe(false);
    expect(result.exportPresetId).toBe("web-fiction");
  });

  it("ao3: html + html ルビ + plain 傍点 + hr ブレイク + blank2 区切り", () => {
    const result = applyExportPreset("ao3", DEFAULT_EXPORT_SETTINGS);
    expect(result.format).toBe("html");
    expect(result.folderHeading).toBe(true);
    expect(result.rubyStyle).toBe("html");
    expect(result.emphasisDotsStyle).toBe("plain");
    expect(result.sceneBreakStyle).toBe("hr");
    expect(result.sceneDivider).toBe("blank2");
    expect(result.exportPresetId).toBe("ao3");
  });

  it("プリセット適用は出力先と独立したユーザー意図フィールドを保持する", () => {
    const current: ExportSettings = {
      ...DEFAULT_EXPORT_SETTINGS,
      includeTrashBin: true,
      paragraphIndent: "fullwidth-space",
    };
    const result = applyExportPreset("narou", current);
    expect(result.includeTrashBin).toBe(true);
    expect(result.paragraphIndent).toBe("fullwidth-space");
  });
});

// ────────────────────────────────────────────────────────────────────
// detectExportPreset — 設定値からサイト ID を逆引き
// ────────────────────────────────────────────────────────────────────

describe("detectExportPreset", () => {
  it("区別可能なサイトは hint なしでも検出される", () => {
    // web-fiction は monogatary と、noveldays 系は互いに同値なので hint 必須（別テスト）。
    const ids: ExportPresetId[] = [
      "narou",
      "kakuyomu",
      "pixiv",
      "aozora",
      "generic-md",
      "word-html",
      "ao3",
    ];
    for (const id of ids) {
      const settings = {
        ...applyExportPreset(id, DEFAULT_EXPORT_SETTINGS),
        exportPresetId: "custom" as ExportPresetId,
      };
      expect(detectExportPreset(settings)).toBe(id);
    }
  });

  it("全登録サイトは hint で自身に復元される", () => {
    for (const id of EXPORT_PRESET_IDS) {
      if (id === "custom") continue;
      const settings = applyExportPreset(id, DEFAULT_EXPORT_SETTINGS);
      expect(detectExportPreset(settings, id)).toBe(id);
    }
  });

  it("同値群（aozora + double-angle）は hint で区別される", () => {
    for (const id of [
      "alphapolis",
      "hameln",
      "novelup",
      "novelism",
      "solispia",
      "estar",
      "aipen",
      "sutekibungei",
      "caita",
      "noveland",
    ] as const) {
      const settings = applyExportPreset(id, DEFAULT_EXPORT_SETTINGS);
      expect(detectExportPreset(settings, id)).toBe(id);
    }
  });

  it("同値群（aozora + per-char 傍点）noveldays/noichigo/maho は hint で区別される", () => {
    for (const id of ["noveldays", "noichigo", "maho"] as const) {
      const settings = applyExportPreset(id, DEFAULT_EXPORT_SETTINGS);
      expect(detectExportPreset(settings, id)).toBe(id);
    }
  });

  it("同値群（base + plain）monogatary/web-fiction は hint で区別される", () => {
    for (const id of ["monogatary", "web-fiction"] as const) {
      const settings = applyExportPreset(id, DEFAULT_EXPORT_SETTINGS);
      expect(detectExportPreset(settings, id)).toBe(id);
    }
  });

  it("hint なしの同値群は登録順で最初の ID を返す", () => {
    // aozora+double-angle 群 → alphapolis（kakuyomu は aozora-auto で別物）
    expect(
      detectExportPreset(
        applyExportPreset("novelism", DEFAULT_EXPORT_SETTINGS),
      ),
    ).toBe("alphapolis");
    // aozora+per-char 群 → noveldays
    expect(
      detectExportPreset(applyExportPreset("maho", DEFAULT_EXPORT_SETTINGS)),
    ).toBe("noveldays");
    // base+plain 群 → monogatary
    expect(
      detectExportPreset(
        applyExportPreset("web-fiction", DEFAULT_EXPORT_SETTINGS),
      ),
    ).toBe("monogatary");
  });

  it("hint が現在の設定と不一致 → hint を無視して通常 detect", () => {
    const narouSettings = applyExportPreset("narou", DEFAULT_EXPORT_SETTINGS);
    expect(detectExportPreset(narouSettings, "kakuyomu")).toBe("narou");
  });

  it("サイトから1項目でも外れる → custom（hint があっても）", () => {
    const narou = applyExportPreset("narou", DEFAULT_EXPORT_SETTINGS);
    const modified: ExportSettings = { ...narou, sceneBreakStyle: "hr" };
    expect(detectExportPreset(modified, "narou")).toBe("custom");
  });

  it("デフォルト設定 → custom（どのサイトにも一致しない）", () => {
    expect(detectExportPreset(DEFAULT_EXPORT_SETTINGS)).toBe("custom");
  });

  it("pixiv の pixivChapterNewpage 変更 → custom", () => {
    const pixiv = applyExportPreset("pixiv", DEFAULT_EXPORT_SETTINGS);
    const modified: ExportSettings = { ...pixiv, pixivChapterNewpage: true };
    expect(detectExportPreset(modified, "pixiv")).toBe("custom");
  });

  it("narou の narouEmphasisMode 変更 → custom", () => {
    const narou = applyExportPreset("narou", DEFAULT_EXPORT_SETTINGS);
    const modified: ExportSettings = {
      ...narou,
      narouEmphasisMode: "per-char",
      emphasisDotsStyle: "narou-emphasis-per-char",
    };
    expect(detectExportPreset(modified, "narou")).toBe("custom");
  });

  it("独立設定の差はプリセット検出に影響しない", () => {
    const narou = applyExportPreset("narou", DEFAULT_EXPORT_SETTINGS);
    const customized: ExportSettings = {
      ...narou,
      includeTrashBin: true,
      paragraphIndent: "fullwidth-space",
    };
    expect(detectExportPreset(customized, "narou")).toBe("narou");
  });
});

// ────────────────────────────────────────────────────────────────────
// validateUserPresetName — カスタムプリセット名バリデーション
// ────────────────────────────────────────────────────────────────────

describe("validateUserPresetName", () => {
  it("空文字 → エラー", () => {
    expect(validateUserPresetName("")).toEqual({ ok: false, reason: "empty" });
    expect(validateUserPresetName("   ")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("長すぎる名前（>40 字）→ エラー", () => {
    expect(validateUserPresetName("あ".repeat(41))).toEqual({
      ok: false,
      reason: "tooLong",
    });
  });

  it("通常名 → OK", () => {
    expect(validateUserPresetName("My Narou Tweaked")).toEqual({ ok: true });
    expect(validateUserPresetName("あ".repeat(40))).toEqual({ ok: true });
  });
});
