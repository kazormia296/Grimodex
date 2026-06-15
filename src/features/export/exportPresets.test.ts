import { describe, it, expect } from "vitest";
import {
  EXPORT_PRESETS,
  EXPORT_PRESET_IDS,
  applyExportPreset,
  detectExportPreset,
  validateUserPresetName,
} from "./exportPresets";
import { DEFAULT_EXPORT_SETTINGS } from "./types";
import type { ExportPresetId, ExportSettings } from "./types";

// ────────────────────────────────────────────────────────────────────
// ビルトインプリセット定義の網羅性
// ────────────────────────────────────────────────────────────────────

describe("EXPORT_PRESETS", () => {
  it("custom 以外の全プリセット ID に定義が存在する", () => {
    for (const id of EXPORT_PRESET_IDS) {
      if (id === "custom") continue;
      expect(EXPORT_PRESETS[id]).toBeDefined();
      expect(EXPORT_PRESETS[id].id).toBe(id);
    }
  });

  it("custom には定義を持たない（特殊扱い）", () => {
    expect(EXPORT_PRESETS).not.toHaveProperty("custom");
  });

  it("各ビルトインプリセットは exportPresetId が自身の id と一致", () => {
    for (const [id, def] of Object.entries(EXPORT_PRESETS)) {
      expect(def.settings.exportPresetId).toBe(id);
    }
  });

  it("英語向けプリセット web-fiction / ao3 が定義されている", () => {
    expect(EXPORT_PRESET_IDS).toContain("web-fiction");
    expect(EXPORT_PRESET_IDS).toContain("ao3");
    expect(EXPORT_PRESETS["web-fiction"]).toBeDefined();
    expect(EXPORT_PRESETS["ao3"]).toBeDefined();
  });

  it("各ビルトインプリセットに region メタデータが付与されている", () => {
    const expected: Record<string, "ja" | "en" | "all"> = {
      narou: "ja",
      kakuyomu: "ja",
      alphapolis: "ja",
      pixiv: "ja",
      hameln: "ja",
      novelup: "ja",
      novelism: "ja",
      aozora: "ja",
      "web-fiction": "en",
      ao3: "en",
      "generic-md": "all",
      "word-html": "all",
    };
    for (const [id, def] of Object.entries(EXPORT_PRESETS)) {
      expect(def.region).toBe(expected[id]);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// applyExportPreset — 完全上書きでの ExportSettings 生成
// ────────────────────────────────────────────────────────────────────

describe("applyExportPreset", () => {
  it("custom は DEFAULT_EXPORT_SETTINGS をそのまま返し exportPresetId=custom", () => {
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

  it("aozora: 青空文庫テキスト形式（｜《》+ ［＃傍点］）", () => {
    const result = applyExportPreset("aozora", DEFAULT_EXPORT_SETTINGS);
    expect(result.format).toBe("plaintext");
    expect(result.rubyStyle).toBe("aozora");
    expect(result.emphasisDotsStyle).toBe("aozora");
    expect(result.exportPresetId).toBe("aozora");
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
    // 英語 web 小説はルビ・傍点を使わないので除去寄りに
    expect(result.rubyStyle).toBe("base");
    expect(result.emphasisDotsStyle).toBe("plain");
    expect(result.sceneBreakStyle).toBe("asterisks");
    expect(result.sceneDivider).toBe("blank");
    // 章見出しはサイト側 UI で付ける前提
    expect(result.folderHeading).toBe(false);
    expect(result.exportPresetId).toBe("web-fiction");
  });

  it("ao3: html + html ルビ + plain 傍点 + hr ブレイク + blank2 区切り", () => {
    const result = applyExportPreset("ao3", DEFAULT_EXPORT_SETTINGS);
    expect(result.format).toBe("html");
    expect(result.folderHeading).toBe(true);
    expect(result.rubyStyle).toBe("html");
    // word-html と違い傍点 span は出さない
    expect(result.emphasisDotsStyle).toBe("plain");
    expect(result.sceneBreakStyle).toBe("hr");
    expect(result.sceneDivider).toBe("blank2");
    expect(result.exportPresetId).toBe("ao3");
  });

  it("プリセット適用は includeTrashBin など『ユーザー意図』フィールドを保持する", () => {
    // includeTrashBin は「ゴミ箱を含むか」というプリセットと無関係な意思決定。
    // プリセット切替で勝手に false に戻されると混乱するので、現在値を引き継ぐ。
    const current: ExportSettings = {
      ...DEFAULT_EXPORT_SETTINGS,
      includeTrashBin: true,
    };
    const result = applyExportPreset("narou", current);
    expect(result.includeTrashBin).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// detectExportPreset — 設定値からプリセット ID を逆引き
// ────────────────────────────────────────────────────────────────────

describe("detectExportPreset", () => {
  it("区別可能なビルトインは hint なしでも検出される", () => {
    const ids: ExportPresetId[] = [
      "narou",
      "kakuyomu",
      "pixiv",
      "aozora",
      "generic-md",
      "word-html",
      "web-fiction",
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

  it("重複ビルトイン（alphapolis/hameln/novelup/novelism）は hint で区別される", () => {
    // 実サイト仕様上、これら4サイトのプリセット中身は同一（aozora ルビ + double-angle 傍点）。
    // hint を渡せばユーザーが選択した ID が維持される。
    for (const id of ["alphapolis", "hameln", "novelup", "novelism"] as const) {
      const settings = applyExportPreset(id, DEFAULT_EXPORT_SETTINGS);
      expect(detectExportPreset(settings, id)).toBe(id);
    }
  });

  it("hint なしで重複ビルトインに該当する設定は最初の ID (alphapolis) を返す", () => {
    // ドキュメント上の挙動: 区別不能なら EXPORT_PRESET_IDS の順序で最初にマッチするもの
    const settings = applyExportPreset("novelism", DEFAULT_EXPORT_SETTINGS);
    expect(detectExportPreset(settings)).toBe("alphapolis");
  });

  it("hint が現在の設定と不一致 → hint を無視して通常 detect", () => {
    const narouSettings = applyExportPreset("narou", DEFAULT_EXPORT_SETTINGS);
    // hint は kakuyomu だが中身は narou
    expect(detectExportPreset(narouSettings, "kakuyomu")).toBe("narou");
  });

  it("ビルトインから1項目でも外れる → custom（hint があっても）", () => {
    const narou = applyExportPreset("narou", DEFAULT_EXPORT_SETTINGS);
    const modified: ExportSettings = { ...narou, sceneBreakStyle: "hr" };
    expect(detectExportPreset(modified, "narou")).toBe("custom");
  });

  it("デフォルト設定 → custom（どのプリセットにも一致しない）", () => {
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

  it("includeTrashBin の差は検出に影響しない（プリセットの一部ではない）", () => {
    const narou = applyExportPreset("narou", DEFAULT_EXPORT_SETTINGS);
    const withTrash: ExportSettings = { ...narou, includeTrashBin: true };
    expect(detectExportPreset(withTrash, "narou")).toBe("narou");
  });
});

// ────────────────────────────────────────────────────────────────────
// validateUserPresetName — カスタムプリセット名バリデーション
// ────────────────────────────────────────────────────────────────────

describe("validateUserPresetName", () => {
  it("空文字 → エラー", () => {
    expect(validateUserPresetName("")).toEqual({
      ok: false,
      reason: "empty",
    });
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
