import { describe, it, expect } from "vitest";
import { generateExport } from "./exportEngine";
import { applyExportPreset } from "./exportPresets";
import { DEFAULT_EXPORT_SETTINGS } from "./types";
import type { ExportPresetId } from "./types";
import type { TreeNodeData } from "@/features/tree/treeStore";

// ────────────────────────────────────────────────────────────────────
// 受け入れ条件のエンドツーエンド検証。
// 本文に ルビ 疑験《シムスティム》 と 傍点 ありえない を含め、各サイトの
// 実出力（generateExport）が仕様どおりかを固定する。
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

const DOC = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "ruby", attrs: { base: "疑験", annotation: "シムスティム" } },
      ],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "ありえない", marks: [{ type: "emphasisDots" }] },
      ],
    },
  ],
});

function exportFor(id: ExportPresetId): string {
  return generateExport({
    nodes: [scene],
    contentMap: { s1: DOC },
    checkedIds: new Set(["s1"]),
    settings: applyExportPreset(id, DEFAULT_EXPORT_SETTINGS),
  });
}

describe("サイト別エクスポート出力（受け入れ条件）", () => {
  it.each([
    "alphapolis",
    "novelism",
    "solispia",
    "estar",
    "aipen",
    "sutekibungei",
    "caita",
    "noveland",
    "hameln",
    "novelup",
  ] as const)("%s: ｜疑験《シムスティム》 + 《《ありえない》》", (id) => {
    const out = exportFor(id);
    expect(out).toContain("｜疑験《シムスティム》");
    expect(out).toContain("《《ありえない》》");
  });

  it("kakuyomu: aozora-auto ルビ（パイプなし）+ 二重山括弧傍点（現挙動）", () => {
    const out = exportFor("kakuyomu");
    expect(out).toContain("疑験《シムスティム》");
    expect(out).not.toContain("｜疑験");
    expect(out).toContain("《《ありえない》》");
  });

  it.each(["noveldays", "noichigo", "maho"] as const)(
    "%s: ｜疑験《シムスティム》 + 傍点は中黒ルビ代用（1字ずつ）",
    (id) => {
      const out = exportFor(id);
      expect(out).toContain("｜疑験《シムスティム》");
      expect(out).toContain("|あ《・》|り《・》|え《・》|な《・》|い《・》");
    },
  );

  it("narou: 現挙動（batch 傍点）が変わらない", () => {
    const out = exportFor("narou");
    expect(out).toContain("｜疑験《シムスティム》");
    expect(out).toContain("|ありえない《・・・・・》");
  });

  it("pixiv: 現挙動（[[rb:]] + double-angle 傍点）が変わらない", () => {
    const out = exportFor("pixiv");
    expect(out).toContain("[[rb:疑験 > シムスティム]]");
    expect(out).toContain("《《ありえない》》");
  });

  it("aozora: ｜疑験《シムスティム》 + ［＃傍点］", () => {
    const out = exportFor("aozora");
    expect(out).toContain("｜疑験《シムスティム》");
    expect(out).toContain("ありえない［＃「ありえない」に傍点］");
  });

  it("monogatary: ルビ・傍点とも除去、本文テキストのみ", () => {
    const out = exportFor("monogatary");
    expect(out).toContain("疑験");
    expect(out).not.toContain("シムスティム");
    expect(out).toContain("ありえない");
    expect(out).not.toContain("《《");
    expect(out).not.toContain("・");
  });
});
