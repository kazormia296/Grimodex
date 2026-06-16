import { describe, it, expect } from "vitest";
import {
  RUBY_PROFILES,
  SECTION_ORDER,
  SITE_IDS,
  SITE_REGISTRY,
  getSectionOrder,
  getSiteEntry,
  getSiteRubyLimit,
  resolveSitePreset,
  siteIdsInSection,
} from "./rubyProfiles";
import { applyExportPreset, detectExportPreset } from "./exportPresets";
import { DEFAULT_EXPORT_SETTINGS } from "./types";
import type { ExportPresetId, ExportSettings } from "./types";

// ────────────────────────────────────────────────────────────────────
// 回帰ガード: 既存サイトの解決値が「旧 exportPresets.ts の実値」と一致すること。
// detectExportPreset が比較する 13 フィールドを凍結し、出力不変を機械的に固定する。
// ────────────────────────────────────────────────────────────────────

type ComparedSettings = Pick<
  ExportSettings,
  | "format"
  | "folderHeading"
  | "folderHeadingStyle"
  | "folderHeadingFormat"
  | "sceneDivider"
  | "sceneDividerCustom"
  | "sceneTitle"
  | "rubyStyle"
  | "emphasisDotsStyle"
  | "sceneBreakStyle"
  | "sceneBreakCustom"
  | "pixivChapterNewpage"
  | "narouEmphasisMode"
>;

const COMMON: ComparedSettings = {
  format: "plaintext",
  folderHeading: false,
  folderHeadingStyle: "squares",
  folderHeadingFormat: "standard",
  sceneDivider: "blank",
  sceneDividerCustom: "",
  sceneTitle: "none",
  rubyStyle: "aozora",
  emphasisDotsStyle: "double-angle",
  sceneBreakStyle: "asterisks",
  sceneBreakCustom: "",
  pixivChapterNewpage: false,
  narouEmphasisMode: "batch",
};

/** 旧 exportPresets.ts の各プリセット実値（写経）。これが変わったら出力回帰。 */
const LEGACY_EXPECTED: Record<string, ComparedSettings> = {
  narou: { ...COMMON, emphasisDotsStyle: "narou-emphasis-batch" },
  kakuyomu: { ...COMMON, rubyStyle: "aozora-auto" },
  alphapolis: { ...COMMON },
  hameln: { ...COMMON },
  novelup: { ...COMMON },
  novelism: { ...COMMON },
  pixiv: {
    ...COMMON,
    folderHeading: true,
    folderHeadingFormat: "pixiv-chapter",
    rubyStyle: "rb-bracket",
    sceneBreakStyle: "custom",
    sceneBreakCustom: "[newpage]",
  },
  aozora: {
    ...COMMON,
    emphasisDotsStyle: "aozora",
    sceneDivider: "blank2",
  },
  "generic-md": {
    ...COMMON,
    format: "markdown",
    folderHeading: true,
    rubyStyle: "parentheses",
    emphasisDotsStyle: "plain",
    sceneBreakStyle: "hr",
    sceneDivider: "blank2",
  },
  "word-html": {
    ...COMMON,
    format: "html",
    folderHeading: true,
    rubyStyle: "html",
    emphasisDotsStyle: "html",
    sceneBreakStyle: "hr",
  },
  "web-fiction": {
    ...COMMON,
    rubyStyle: "base",
    emphasisDotsStyle: "plain",
  },
  ao3: {
    ...COMMON,
    format: "html",
    folderHeading: true,
    rubyStyle: "html",
    emphasisDotsStyle: "plain",
    sceneBreakStyle: "hr",
    sceneDivider: "blank2",
  },
};

describe("resolveSitePreset — 既存サイトの出力不変（回帰ガード）", () => {
  for (const [id, expected] of Object.entries(LEGACY_EXPECTED)) {
    it(`${id} の解決値が旧プリセット実値と一致する`, () => {
      const resolved = resolveSitePreset(id);
      for (const key of Object.keys(expected) as (keyof ComparedSettings)[]) {
        expect(resolved[key], `${id}.${key}`).toBe(expected[key]);
      }
      expect(resolved.exportPresetId).toBe(id);
    });
  }
});

// ────────────────────────────────────────────────────────────────────
// 新規サイトの解決値
// ────────────────────────────────────────────────────────────────────

describe("resolveSitePreset — 新規サイト", () => {
  it("jp-double-angle 系の新規サイトは aozora + double-angle", () => {
    for (const id of [
      "solispia",
      "estar",
      "aipen",
      "sutekibungei",
      "caita",
      "noveland",
    ] as const) {
      const s = resolveSitePreset(id);
      expect(s.rubyStyle).toBe("aozora");
      expect(s.emphasisDotsStyle).toBe("double-angle");
      expect(s.format).toBe("plaintext");
      expect(s.sceneDivider).toBe("blank");
      expect(s.exportPresetId).toBe(id);
    }
  });

  it("noveldays/noichigo/maho は aozora + 傍点ルビ代用（per-char）", () => {
    for (const id of ["noveldays", "noichigo", "maho"] as const) {
      const s = resolveSitePreset(id);
      expect(s.rubyStyle).toBe("aozora");
      expect(s.emphasisDotsStyle).toBe("narou-emphasis-per-char");
      expect(s.exportPresetId).toBe(id);
    }
  });

  it("monogatary はルビ・傍点とも除去（base + plain）", () => {
    const s = resolveSitePreset("monogatary");
    expect(s.rubyStyle).toBe("base");
    expect(s.emphasisDotsStyle).toBe("plain");
  });

  it("未登録 ID は custom にフォールバック", () => {
    const s = resolveSitePreset("nonexistent-site");
    expect(s.exportPresetId).toBe("custom");
  });
});

// ────────────────────────────────────────────────────────────────────
// レジストリ整合性
// ────────────────────────────────────────────────────────────────────

describe("SITE_REGISTRY 整合性", () => {
  it("SITE_IDS に重複がない", () => {
    expect(new Set(SITE_IDS).size).toBe(SITE_IDS.length);
  });

  it("全サイトの解決値 exportPresetId が自身の id と一致", () => {
    for (const id of SITE_IDS) {
      expect(resolveSitePreset(id).exportPresetId).toBe(id);
    }
  });

  it("各サイトの profileId は実在するプロファイルを指す", () => {
    for (const id of SITE_IDS) {
      const entry = SITE_REGISTRY[id];
      expect(RUBY_PROFILES[entry.profileId]).toBeDefined();
    }
  });

  it("各サイトの section は SECTION_ORDER に含まれる", () => {
    const known = new Set(SECTION_ORDER.map((s) => s.id));
    for (const id of SITE_IDS) {
      expect(known.has(SITE_REGISTRY[id].section)).toBe(true);
    }
  });

  it("プロファイル settings は placeholder exportPresetId=custom を持つ", () => {
    for (const p of Object.values(RUBY_PROFILES)) {
      expect(p.settings.exportPresetId).toBe("custom");
    }
  });
});

describe("なろう per-char トグル後の警告ラベル不変条件（回帰防止）", () => {
  // ExportPresetPicker の警告バナー siteLabel は detect ではなく settings.exportPresetId に
  // 紐づける（rubyLimit の出所と一致）。per-char トグル後は detect=custom だが exportPresetId は
  // narou のまま → ラベル源が解決できないと "の文字数上限を超えています" と崩れる。
  it("per-char トグル後: detect=custom でもラベル源 exportPresetId は narou に解決できる", () => {
    const narou = applyExportPreset("narou", DEFAULT_EXPORT_SETTINGS);
    const toggled: ExportSettings = {
      ...narou,
      narouEmphasisMode: "per-char",
      emphasisDotsStyle: "narou-emphasis-per-char",
    };
    // 現挙動: noveldays 等に誤吸着せず custom（narouEmphasisMode=batch が群を分離している）
    expect(detectExportPreset(toggled, toggled.exportPresetId)).toBe("custom");
    // 警告は exportPresetId=narou の rubyLimit で計算されるので、ラベル源も narou で非空
    expect(toggled.exportPresetId).toBe("narou");
    expect(getSiteRubyLimit(toggled.exportPresetId)).toEqual({
      baseMax: 10,
      rubyMax: 10,
    });
    expect(getSiteEntry(toggled.exportPresetId)).not.toBeNull();
  });
});

describe("getSiteRubyLimit", () => {
  it("文字数上限を持つサイトのみ値を返す", () => {
    expect(getSiteRubyLimit("narou")).toEqual({ baseMax: 10, rubyMax: 10 });
    expect(getSiteRubyLimit("kakuyomu")).toEqual({ baseMax: 20, rubyMax: 50 });
    expect(getSiteRubyLimit("novelup")).toEqual({ baseMax: 50, rubyMax: 50 });
  });

  it("上限未定義サイトは null", () => {
    for (const id of ["alphapolis", "monogatary", "pixiv", "aozora"] as const) {
      expect(getSiteRubyLimit(id)).toBeNull();
    }
  });
});

describe("siteIdsInSection / SECTION_ORDER", () => {
  it("英語圏セクションは web-fiction / ao3 を含む", () => {
    expect(siteIdsInSection("english")).toEqual(["web-fiction", "ao3"]);
  });

  it("汎用セクションは generic-md / word-html を含む", () => {
    expect(siteIdsInSection("generic")).toEqual(["generic-md", "word-html"]);
  });

  it("全 SITE_IDS は SECTION_ORDER のいずれかのセクションに現れる", () => {
    const all = SECTION_ORDER.flatMap((s) =>
      siteIdsInSection(s.id),
    ) as ExportPresetId[];
    expect(new Set(all)).toEqual(new Set(SITE_IDS));
  });
});

describe("getSectionOrder（言語別並べ替え）", () => {
  it("ja は SECTION_ORDER 既定（英語圏が末尾）", () => {
    const order = getSectionOrder("ja").map((s) => s.id);
    expect(order).toEqual(SECTION_ORDER.map((s) => s.id));
    expect(order[order.length - 1]).toBe("english");
  });

  it("en は英語圏 → 汎用 → 日本語系の順（英語が先頭）", () => {
    const order = getSectionOrder("en").map((s) => s.id);
    expect(order).toEqual([
      "english",
      "generic",
      "jp-double-angle",
      "jp-ruby-emphasis",
      "pixiv",
      "aozora-bunko",
      "plain-only",
    ]);
  });

  it("未指定 / その他言語は ja 既定にフォールバック", () => {
    expect(getSectionOrder("fr").map((s) => s.id)).toEqual(
      SECTION_ORDER.map((s) => s.id),
    );
  });

  it("並べ替えてもセクションの集合は不変（欠落・重複なし）", () => {
    const en = getSectionOrder("en").map((s) => s.id);
    expect(new Set(en)).toEqual(new Set(SECTION_ORDER.map((s) => s.id)));
    expect(en.length).toBe(SECTION_ORDER.length);
  });
});
