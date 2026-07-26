import { describe, it, expect } from "vitest";
import { generateExport, renderPmDocToArchiveMarkdown } from "./exportEngine";
import {
  applyExportPreset,
  detectExportPreset,
  resolveStoredTateChuYoko,
} from "./exportPresets";
import { resolveSitePreset } from "./rubyProfiles";
import { DEFAULT_EXPORT_SETTINGS } from "./types";
import type {
  ExportPresetId,
  ExportSettings,
  TateChuYokoExportStyle,
} from "./types";
import type { TateChuYokoPolicy } from "@/features/editor/tateChuYokoPolicy";
import type { TreeNodeData } from "@/features/tree/treeStore";

// ────────────────────────────────────────────────────────────────────
// 縦中横エクスポート記法。本文の半角数字 run に対し、サイトごとの記法を出す。
// ────────────────────────────────────────────────────────────────────

const scene: TreeNodeData = {
  id: "s1",
  projectId: "p1",
  parentId: null,
  nodeType: "scene",
  title: "S",
  synopsis: null,
  intent: null,
  sortOrder: "a0",
  status: null,
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  createdAt: "2024-01-01T00:00:00Z",
  charCount: 0,
  updatedAt: "2024-01-01T00:00:00Z",
};

/** 数字 run を本文に含む doc を作る。 */
function docWith(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

function exportWith(
  text: string,
  overrides: Partial<ExportSettings>,
  policy?: TateChuYokoPolicy,
): string {
  return generateExport({
    nodes: [scene],
    contentMap: { s1: docWith(text) },
    checkedIds: new Set(["s1"]),
    settings: { ...DEFAULT_EXPORT_SETTINGS, ...overrides },
    tateChuYokoPolicy: policy,
  });
}

function exportForSite(text: string, id: ExportPresetId): string {
  return generateExport({
    nodes: [scene],
    contentMap: { s1: docWith(text) },
    checkedIds: new Set(["s1"]),
    settings: applyExportPreset(id, DEFAULT_EXPORT_SETTINGS),
  });
}

/** run 全体に tcy マークを付けた doc。 */
function docWithTcyMark(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text, marks: [{ type: "tcy" }] }],
      },
    ],
  });
}

function exportMarkedTcy(
  text: string,
  overrides: Partial<ExportSettings>,
  policy?: TateChuYokoPolicy,
): string {
  return generateExport({
    nodes: [scene],
    contentMap: { s1: docWithTcyMark(text) },
    checkedIds: new Set(["s1"]),
    settings: { ...DEFAULT_EXPORT_SETTINGS, ...overrides },
    tateChuYokoPolicy: policy,
  });
}

describe("縦中横 archive round-trip（明示マークを失わない）", () => {
  it("archive markdown は明示 tcy を aozora-range で残し、auto の数字は焼かない", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "西暦" },
            { type: "text", text: "29", marks: [{ type: "tcy" }] },
            { type: "text", text: "年 と 12 章" },
          ],
        },
      ],
    });
    const md = renderPmDocToArchiveMarkdown(doc);
    // 明示マーク "29" は記法として保存（ruby=括弧 / 傍点=《《》》 と同じ扱い）
    expect(md).toContain("［＃縦中横］29［＃縦中横終わり］");
    // マーク無しの "12"（auto 対象）は素の数字のまま（archive は auto を焼き込まない）
    expect(md).toContain("12 章");
    expect(md).not.toContain("［＃縦中横］12");
  });
});

describe("縦中横エクスポート — 明示 TcyMark", () => {
  it("マーク run は policy 非依存で記法を出す（policy off・非数字でも）", () => {
    // "四" は auto 検出対象外(半角数字/記号/ローマ数字でない)かつ policy off。
    // それでも明示マークなら縦中横記法が出る。
    const out = exportMarkedTcy("四", { tateChuYoko: "aozora-range" }, "off");
    expect(out).toContain("［＃縦中横］四［＃縦中横終わり］");
  });

  it("aozora-forward スタイルでも明示マークを出力する", () => {
    const out = exportMarkedTcy("四", { tateChuYoko: "aozora-forward" }, "off");
    expect(out).toContain("四［＃「四」は縦中横］");
  });

  it("style none のときはマークでも記法を出さない", () => {
    const out = exportMarkedTcy("四", { tateChuYoko: "none" }, "all");
    expect(out).toContain("四");
    expect(out).not.toContain("縦中横");
  });
});

describe("縦中横エクスポート記法 — スタイル別", () => {
  it("none: 記法を出さず半角数字をそのまま残す", () => {
    const out = exportWith("Ｂ29を確認", { tateChuYoko: "none" });
    expect(out).toContain("Ｂ29を確認");
    expect(out).not.toContain("縦中横");
    expect(out).not.toContain("[tatechuyoko]");
  });

  it("aozora-forward: 前方参照型（run の直後に注記）", () => {
    const out = exportWith("Ｂ29を確認", { tateChuYoko: "aozora-forward" });
    expect(out).toContain("Ｂ29［＃「29」は縦中横］を確認");
  });

  it("aozora-range: 範囲指定型（前後で挟む）", () => {
    const out = exportWith("Ｂ29を確認", { tateChuYoko: "aozora-range" });
    expect(out).toContain("Ｂ［＃縦中横］29［＃縦中横終わり］を確認");
  });

  it("caita: [tatechuyoko]…[/tatechuyoko] で包む", () => {
    const out = exportWith("Ｂ29を確認", { tateChuYoko: "caita" });
    expect(out).toContain("Ｂ[tatechuyoko]29[/tatechuyoko]を確認");
  });

  it("複数 run をそれぞれ独立に処理する", () => {
    const out = exportWith("12と34", { tateChuYoko: "aozora-forward" });
    expect(out).toContain("12［＃「12」は縦中横］と34［＃「34」は縦中横］");
  });

  it('html-span: <span class="tcy"> で包む（CSS 組版向け）', () => {
    const out = exportWith("Ｂ29を確認", {
      format: "html",
      tateChuYoko: "html-span",
    });
    expect(out).toContain('Ｂ<span class="tcy">29</span>を確認');
  });
});

describe("縦中横エクスポート記法 — 対象 run の length ポリシー", () => {
  it("policy '2': 2桁のみ対象（1桁・3桁は対象外）", () => {
    const out = exportWith("1と29と123", { tateChuYoko: "caita" }, "2");
    expect(out).toContain("1と[tatechuyoko]29[/tatechuyoko]と123");
  });

  it("policy 'all': 2桁以上をすべて対象（1桁は対象外）", () => {
    const out = exportWith("1と29と123", { tateChuYoko: "caita" }, "all");
    expect(out).toContain(
      "1と[tatechuyoko]29[/tatechuyoko]と[tatechuyoko]123[/tatechuyoko]",
    );
  });

  it("policy 'off': スタイルが設定されていても記法を出さない", () => {
    const out = exportWith("29を確認", { tateChuYoko: "caita" }, "off");
    expect(out).toContain("29を確認");
    expect(out).not.toContain("[tatechuyoko]");
  });

  it("policy 未指定なら既定 '2' として扱う", () => {
    const out = exportWith("29と123", { tateChuYoko: "caita" });
    expect(out).toContain("[tatechuyoko]29[/tatechuyoko]と123");
  });
});

describe("縦中横エクスポート記法 — 記号クラスタ / ローマ数字（拡張）", () => {
  it("感嘆符・疑問符クラスタ（！？）を包む（policy 2 でも対象）", () => {
    const out = exportWith("本当に！？", { tateChuYoko: "caita" }, "2");
    expect(out).toContain("本当に[tatechuyoko]！？[/tatechuyoko]");
  });

  it("ASCII ローマ数字（III）を包む（桁ポリシー非依存）", () => {
    const out = exportWith("第III章", { tateChuYoko: "caita" }, "2");
    expect(out).toContain("第[tatechuyoko]III[/tatechuyoko]章");
  });

  it("Unicode ローマ数字（Ⅶ）を包む", () => {
    const out = exportWith("Ⅶ巻", { tateChuYoko: "caita" }, "all");
    expect(out).toContain("[tatechuyoko]Ⅶ[/tatechuyoko]巻");
  });

  it("厳密なローマ数字でない英単語（VIVID）は包まない（誤結合防止）", () => {
    const out = exportWith("VIVID", { tateChuYoko: "caita" }, "all");
    expect(out).toContain("VIVID");
    expect(out).not.toContain("[tatechuyoko]");
  });

  it("policy 'off' では記号・ローマ数字も出さない", () => {
    const out = exportWith("第III章！？", { tateChuYoko: "caita" }, "off");
    expect(out).not.toContain("[tatechuyoko]");
  });
});

describe("縦中横エクスポート記法 — プロファイル/サイト連携", () => {
  it("青空文庫プロファイルの既定は前方参照型", () => {
    expect(
      resolveSitePreset("aozora").tateChuYoko,
    ).toBe<TateChuYokoExportStyle>("aozora-forward");
    const out = exportForSite("西暦12年", "aozora");
    expect(out).toContain("西暦12［＃「12」は縦中横］年");
  });

  it("caita サイトは [tatechuyoko] 記法", () => {
    expect(resolveSitePreset("caita").tateChuYoko).toBe<TateChuYokoExportStyle>(
      "caita",
    );
    const out = exportForSite("西暦12年", "caita");
    expect(out).toContain("西暦[tatechuyoko]12[/tatechuyoko]年");
  });

  it("他の jp-double-angle 系サイト（alphapolis 等）は記法なし", () => {
    for (const id of ["alphapolis", "kakuyomu", "narou", "pixiv"] as const) {
      expect(resolveSitePreset(id).tateChuYoko).toBe<TateChuYokoExportStyle>(
        "none",
      );
      const out = exportForSite("西暦12年", id);
      expect(out).toContain("西暦12年");
      expect(out).not.toContain("縦中横");
      expect(out).not.toContain("[tatechuyoko]");
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// 回帰: 旧ストア移行（tateChuYoko キー未保存 → プリセットから導出）
// COMPARED_FIELDS に tateChuYoko を入れたので、移行しないと保存済み
// caita が alphapolis に、青空文庫が custom に取り違えられる。
// ────────────────────────────────────────────────────────────────────

describe("resolveStoredTateChuYoko — 旧ストア移行", () => {
  it("保存値があればそれを使う", () => {
    expect(resolveStoredTateChuYoko("aozora-range", "aozora")).toBe(
      "aozora-range",
    );
  });

  it("未保存(undefined/空)なら選択中プリセットから導出", () => {
    expect(resolveStoredTateChuYoko(undefined, "caita")).toBe("caita");
    expect(resolveStoredTateChuYoko("", "aozora")).toBe("aozora-forward");
    expect(resolveStoredTateChuYoko(null, "alphapolis")).toBe("none");
    expect(resolveStoredTateChuYoko(undefined, "custom")).toBe("none");
  });

  it("移行後の設定は元プリセットへ正しく detect される（誤吸着しない）", () => {
    // 旧 caita ユーザー: 保存に tateChuYoko キー無し → 導出で "caita" になり、
    // detect が alphapolis ではなく caita を返す。
    for (const id of ["caita", "aozora"] as const) {
      const migrated: ExportSettings = {
        ...applyExportPreset(id, DEFAULT_EXPORT_SETTINGS),
        tateChuYoko: resolveStoredTateChuYoko(undefined, id),
      };
      expect(detectExportPreset(migrated, id)).toBe(id);
    }
  });

  it("移行しないと caita は alphapolis に化ける（バグ実証 = 移行の必要性）", () => {
    const broken: ExportSettings = {
      ...applyExportPreset("caita", DEFAULT_EXPORT_SETTINGS),
      tateChuYoko: "none", // 旧既定フォールバック（移行なし）
    };
    expect(detectExportPreset(broken, "caita")).toBe("alphapolis");
  });
});

// ────────────────────────────────────────────────────────────────────
// 回帰: 未知 style の防御（union 外の実行時値で数字が消えない）
// ────────────────────────────────────────────────────────────────────

describe("縦中横エクスポート記法 — 未知 style の防御", () => {
  it("破損した style 値でも本文の数字を素通しする（'undefined' に化けない）", () => {
    const out = exportWith("西暦29年", {
      tateChuYoko: "bogus-style" as ExportSettings["tateChuYoko"],
    });
    expect(out).toContain("西暦29年");
    expect(out).not.toContain("undefined");
  });
});

// ────────────────────────────────────────────────────────────────────
// 回帰: 傍点(emphasisDots)が乗った数字 run では縦中横注記をネストさせない
// ────────────────────────────────────────────────────────────────────

function docWithEmphasizedText(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text, marks: [{ type: "emphasisDots" }] }],
      },
    ],
  });
}

describe("縦中横エクスポート記法 — 傍点との非ネスト", () => {
  it("青空文庫プリセットで傍点付き数字に縦中横注記をネストさせない", () => {
    const out = generateExport({
      nodes: [scene],
      contentMap: { s1: docWithEmphasizedText("29") },
      checkedIds: new Set(["s1"]),
      settings: applyExportPreset("aozora", DEFAULT_EXPORT_SETTINGS),
    });
    // 傍点注記は出る。縦中横注記は出さない（= ネストした不正注記を作らない）。
    expect(out).toContain("29［＃「29」に傍点］");
    expect(out).not.toContain("は縦中横");
  });

  it("caita でも傍点付き数字には [tatechuyoko] を付けない", () => {
    const settings: ExportSettings = {
      ...DEFAULT_EXPORT_SETTINGS,
      tateChuYoko: "caita",
      emphasisDotsStyle: "double-angle",
    };
    const out = generateExport({
      nodes: [scene],
      contentMap: { s1: docWithEmphasizedText("29") },
      checkedIds: new Set(["s1"]),
      settings,
    });
    expect(out).toContain("《《29》》");
    expect(out).not.toContain("[tatechuyoko]");
  });
});
