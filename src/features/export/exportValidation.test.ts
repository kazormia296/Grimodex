import { describe, it, expect } from "vitest";
import { validateExportRubyLengths } from "./exportValidation";
import type { TreeNodeData } from "@/features/tree/treeStore";

function scene(id: string, title: string): TreeNodeData {
  return {
    id,
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title,
    synopsis: null,
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
}

/** ruby ノードを含む段落の ProseMirror JSON 文字列を作る */
function rubyDoc(base: string, annotation: string): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "ruby", attrs: { base, annotation } }],
      },
    ],
  });
}

describe("validateExportRubyLengths", () => {
  it("ルビ制限なしのプリセット → 空配列", () => {
    const s1 = scene("s1", "S1");
    const warnings = validateExportRubyLengths({
      nodes: [s1],
      contentMap: { s1: rubyDoc("漢字", "かんじ") },
      checkedIds: new Set(["s1"]),
      presetId: "alphapolis", // rubyLimit なし
    });
    expect(warnings).toEqual([]);
  });

  it("custom プリセット → 空配列（バリデーション対象外）", () => {
    const s1 = scene("s1", "S1");
    const warnings = validateExportRubyLengths({
      nodes: [s1],
      contentMap: { s1: rubyDoc("非常に長い漢字の塊", "ふりがな") },
      checkedIds: new Set(["s1"]),
      presetId: "custom",
    });
    expect(warnings).toEqual([]);
  });

  it("narou (baseMax=10): 11字の base で警告", () => {
    const s1 = scene("s1", "問題シーン");
    const warnings = validateExportRubyLengths({
      nodes: [s1],
      contentMap: { s1: rubyDoc("あ".repeat(11), "ふり") },
      checkedIds: new Set(["s1"]),
      presetId: "narou",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      sceneId: "s1",
      sceneTitle: "問題シーン",
      exceeded: "base",
      limit: 10,
      actual: 11,
    });
  });

  it("kakuyomu (baseMax=20, rubyMax=50): ruby が51字 → 警告", () => {
    const s1 = scene("s1", "S1");
    const warnings = validateExportRubyLengths({
      nodes: [s1],
      contentMap: { s1: rubyDoc("漢字", "あ".repeat(51)) },
      checkedIds: new Set(["s1"]),
      presetId: "kakuyomu",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].exceeded).toBe("ruby");
    expect(warnings[0].limit).toBe(50);
    expect(warnings[0].actual).toBe(51);
  });

  it("制限内 → 警告なし", () => {
    const s1 = scene("s1", "S1");
    const warnings = validateExportRubyLengths({
      nodes: [s1],
      contentMap: { s1: rubyDoc("漢字", "かんじ") },
      checkedIds: new Set(["s1"]),
      presetId: "narou",
    });
    expect(warnings).toEqual([]);
  });

  it("チェックされていないシーンは検査対象外", () => {
    const s1 = scene("s1", "S1");
    const warnings = validateExportRubyLengths({
      nodes: [s1],
      contentMap: { s1: rubyDoc("あ".repeat(11), "ふり") },
      checkedIds: new Set(), // 非チェック
      presetId: "narou",
    });
    expect(warnings).toEqual([]);
  });

  it("複数ルビ・複数シーンで警告が累積される", () => {
    const s1 = scene("s1", "S1");
    const s2 = scene("s2", "S2");
    const warnings = validateExportRubyLengths({
      nodes: [s1, s2],
      contentMap: {
        // narou: baseMax=10, rubyMax=10
        s1: rubyDoc("あ".repeat(15), "ふり"), // base 超過
        s2: rubyDoc("漢字", "ふ".repeat(12)), // ruby 超過
      },
      checkedIds: new Set(["s1", "s2"]),
      presetId: "narou",
    });
    expect(warnings).toHaveLength(2);
  });

  it("不正な JSON はスキップ（クラッシュしない）", () => {
    const s1 = scene("s1", "S1");
    const warnings = validateExportRubyLengths({
      nodes: [s1],
      contentMap: { s1: "INVALID JSON {{{" },
      checkedIds: new Set(["s1"]),
      presetId: "narou",
    });
    expect(warnings).toEqual([]);
  });

  it("ネストした構造の中の ruby ノードも検出する", () => {
    const s1 = scene("s1", "S1");
    const nestedDoc = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "ruby",
                  attrs: { base: "あ".repeat(15), annotation: "ふり" },
                },
              ],
            },
          ],
        },
      ],
    });
    const warnings = validateExportRubyLengths({
      nodes: [s1],
      contentMap: { s1: nestedDoc },
      checkedIds: new Set(["s1"]),
      presetId: "narou",
    });
    expect(warnings).toHaveLength(1);
  });
});
