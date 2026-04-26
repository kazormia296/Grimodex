import { describe, it, expect } from "vitest";
import { generateExport } from "./exportEngine";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { ExportSettings } from "./types";
import { DEFAULT_EXPORT_SETTINGS } from "./types";

// ────────────────────────────────────────────────────────────────────
// ヘルパー
// ────────────────────────────────────────────────────────────────────

function makeFolder(
  id: string,
  title: string,
  parentId: string | null = null,
  sortOrder = "a0",
): TreeNodeData {
  return {
    id,
    projectId: "p1",
    parentId,
    nodeType: "folder",
    title,
    synopsis: null,
    sortOrder,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    createdAt: "2024-01-01T00:00:00Z",
  };
}

function makeScene(
  id: string,
  title: string,
  parentId: string | null = null,
  sortOrder = "a0",
): TreeNodeData {
  return {
    id,
    projectId: "p1",
    parentId,
    nodeType: "scene",
    title,
    synopsis: null,
    sortOrder,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    createdAt: "2024-01-01T00:00:00Z",
  };
}

function makeNote(id: string, parentId: string | null = null): TreeNodeData {
  return {
    id,
    projectId: "p1",
    parentId,
    nodeType: "note",
    title: "note",
    synopsis: null,
    sortOrder: "a0",
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    createdAt: "2024-01-01T00:00:00Z",
  };
}

/** ProseMirrorの段落JSONを作成 */
function para(...texts: string[]): object {
  return {
    type: "paragraph",
    content: texts.map((t) => ({ type: "text", text: t })),
  };
}

/** ProseMirrorのドキュメントJSONを作成 */
function doc(...nodes: object[]): string {
  return JSON.stringify({ type: "doc", content: nodes });
}

function settings(overrides: Partial<ExportSettings> = {}): ExportSettings {
  return { ...DEFAULT_EXPORT_SETTINGS, ...overrides };
}

// ────────────────────────────────────────────────────────────────────
// エッジケース
// ────────────────────────────────────────────────────────────────────

describe("generateExport - edge cases", () => {
  it("選択なし → 空文字列", () => {
    const s1 = makeScene("s1", "シーン1");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(),
      settings: settings(),
    });
    expect(result).toBe("");
  });

  it("フォルダーなし・シーン1件 → 見出しなし・区切りなし", () => {
    const s1 = makeScene("s1", "シーン1");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: doc(para("本文テキスト")) },
      checkedIds: new Set(["s1"]),
      settings: settings(),
    });
    expect(result).toBe("本文テキスト\n");
  });

  it("Noteノードはツリーから除外される", () => {
    const n1 = makeNote("n1");
    const result = generateExport({
      nodes: [n1],
      contentMap: { n1: doc(para("ノート")) },
      checkedIds: new Set(["n1"]),
      settings: settings(),
    });
    expect(result).toBe("");
  });

  it("チェック済みシーンがないフォルダーは見出しを出力しない", () => {
    const f1 = makeFolder("f1", "第一部");
    const s1 = makeScene("s1", "シーン1", "f1");
    const result = generateExport({
      nodes: [f1, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(), // 何もチェックしない
      settings: settings({ folderHeading: true }),
    });
    expect(result).toBe("");
  });

  it("contentMapに存在しないシーンは空文字として扱う", () => {
    const s1 = makeScene("s1", "シーン1");
    const result = generateExport({
      nodes: [s1],
      contentMap: {},
      checkedIds: new Set(["s1"]),
      settings: settings(),
    });
    expect(result).toBe("\n");
  });
});

// ────────────────────────────────────────────────────────────────────
// フォルダー見出し
// ────────────────────────────────────────────────────────────────────

describe("generateExport - folder headings (plaintext)", () => {
  it("深さ0: ■ 記号", () => {
    const f1 = makeFolder("f1", "第一部");
    const s1 = makeScene("s1", "シーン1", "f1");
    const result = generateExport({
      nodes: [f1, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({
        format: "plaintext",
        folderHeadingStyle: "squares",
      }),
    });
    expect(result).toContain("■ 第一部");
  });

  it("深さ1: □ 記号", () => {
    const f1 = makeFolder("f1", "第一部", null, "a0");
    const f2 = makeFolder("f2", "第1章", "f1", "a0");
    const s1 = makeScene("s1", "シーン1", "f2", "a0");
    const result = generateExport({
      nodes: [f1, f2, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({
        format: "plaintext",
        folderHeadingStyle: "squares",
      }),
    });
    expect(result).toContain("■ 第一部");
    expect(result).toContain("□ 第1章");
  });

  it("深さ2: ◇ 記号", () => {
    const f1 = makeFolder("f1", "第一部", null, "a0");
    const f2 = makeFolder("f2", "第1章", "f1", "a0");
    const f3 = makeFolder("f3", "セクション", "f2", "a0");
    const s1 = makeScene("s1", "シーン1", "f3", "a0");
    const result = generateExport({
      nodes: [f1, f2, f3, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({
        format: "plaintext",
        folderHeadingStyle: "squares",
      }),
    });
    expect(result).toContain("◇ セクション");
  });

  it("深さ3以深: ・ 記号", () => {
    const f1 = makeFolder("f1", "L1", null, "a0");
    const f2 = makeFolder("f2", "L2", "f1", "a0");
    const f3 = makeFolder("f3", "L3", "f2", "a0");
    const f4 = makeFolder("f4", "L4", "f3", "a0");
    const s1 = makeScene("s1", "シーン1", "f4", "a0");
    const result = generateExport({
      nodes: [f1, f2, f3, f4, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({
        format: "plaintext",
        folderHeadingStyle: "squares",
      }),
    });
    expect(result).toContain("・ L4");
  });

  it("brackets スタイル: 【】〈〉「」", () => {
    const f1 = makeFolder("f1", "第一部", null, "a0");
    const f2 = makeFolder("f2", "第1章", "f1", "a0");
    const f3 = makeFolder("f3", "セクション", "f2", "a0");
    const s1 = makeScene("s1", "シーン1", "f3", "a0");
    const result = generateExport({
      nodes: [f1, f2, f3, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({
        format: "plaintext",
        folderHeadingStyle: "brackets",
      }),
    });
    expect(result).toContain("【第一部】");
    expect(result).toContain("〈第1章〉");
    expect(result).toContain("「セクション」");
  });

  it("numbers スタイル: 記号なし・タイトルのみ", () => {
    const f1 = makeFolder("f1", "第一部");
    const s1 = makeScene("s1", "シーン1", "f1");
    const result = generateExport({
      nodes: [f1, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({
        format: "plaintext",
        folderHeadingStyle: "numbers",
      }),
    });
    expect(result).toContain("第一部");
    expect(result).not.toContain("■");
  });

  it("folderHeading=false のとき見出しを出力しない", () => {
    const f1 = makeFolder("f1", "第一部");
    const s1 = makeScene("s1", "シーン1", "f1");
    const result = generateExport({
      nodes: [f1, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ folderHeading: false }),
    });
    expect(result).not.toContain("第一部");
  });
});

describe("generateExport - folder headings (markdown)", () => {
  it("深さ0: # 見出し", () => {
    const f1 = makeFolder("f1", "第一部");
    const s1 = makeScene("s1", "シーン1", "f1");
    const result = generateExport({
      nodes: [f1, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "markdown" }),
    });
    expect(result).toContain("# 第一部");
  });

  it("深さ1: ## 見出し", () => {
    const f1 = makeFolder("f1", "第一部", null, "a0");
    const f2 = makeFolder("f2", "第1章", "f1", "a0");
    const s1 = makeScene("s1", "シーン1", "f2", "a0");
    const result = generateExport({
      nodes: [f1, f2, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "markdown" }),
    });
    expect(result).toContain("# 第一部");
    expect(result).toContain("## 第1章");
  });
});

describe("generateExport - folder headings (html)", () => {
  it("深さ0: <h1>", () => {
    const f1 = makeFolder("f1", "第一部");
    const s1 = makeScene("s1", "シーン1", "f1");
    const result = generateExport({
      nodes: [f1, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "html" }),
    });
    expect(result).toContain("<h1>第一部</h1>");
  });

  it("深さ1: <h2>", () => {
    const f1 = makeFolder("f1", "第一部", null, "a0");
    const f2 = makeFolder("f2", "第1章", "f1", "a0");
    const s1 = makeScene("s1", "シーン1", "f2", "a0");
    const result = generateExport({
      nodes: [f1, f2, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "html" }),
    });
    expect(result).toContain("<h2>第1章</h2>");
  });

  it("HTMLは完全なHTML文書として出力される", () => {
    const s1 = makeScene("s1", "シーン1");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "html" }),
      projectTitle: "My Novel",
      projectLanguage: "ja",
    });
    expect(result).toContain("<!DOCTYPE html>");
    expect(result).toContain('<html lang="ja">');
    expect(result).toContain("<title>My Novel</title>");
    expect(result).toContain("<body>");
    expect(result).toContain("</body>");
  });
});

// ────────────────────────────────────────────────────────────────────
// シーン区切り
// ────────────────────────────────────────────────────────────────────

describe("generateExport - scene dividers", () => {
  const f1 = makeFolder("f1", "第一部");
  const s1 = makeScene("s1", "シーン1", "f1", "a0");
  const s2 = makeScene("s2", "シーン2", "f1", "a1");
  const nodes = [f1, s1, s2];
  const contentMap = {
    s1: doc(para("シーン1本文")),
    s2: doc(para("シーン2本文")),
  };
  const checked = new Set(["s1", "s2"]);

  it("blank: シーン間に空行", () => {
    const result = generateExport({
      nodes,
      contentMap,
      checkedIds: checked,
      settings: settings({ format: "plaintext", sceneDivider: "blank" }),
    });
    expect(result).toContain("シーン1本文\n\nシーン2本文");
  });

  it("blank2: シーン間に2行空行", () => {
    const result = generateExport({
      nodes,
      contentMap,
      checkedIds: checked,
      settings: settings({ format: "plaintext", sceneDivider: "blank2" }),
    });
    expect(result).toContain("シーン1本文\n\n\nシーン2本文");
  });

  it("asterisks: * * * 区切り", () => {
    const result = generateExport({
      nodes,
      contentMap,
      checkedIds: checked,
      settings: settings({ format: "plaintext", sceneDivider: "asterisks" }),
    });
    expect(result).toContain("シーン1本文\n\n* * *\n\nシーン2本文");
  });

  it("rule: 全角罫線", () => {
    const result = generateExport({
      nodes,
      contentMap,
      checkedIds: checked,
      settings: settings({ format: "plaintext", sceneDivider: "rule" }),
    });
    expect(result).toContain("シーン1本文\n\n────────\n\nシーン2本文");
  });

  it("none: 区切りなし（改行のみ）", () => {
    const result = generateExport({
      nodes,
      contentMap,
      checkedIds: checked,
      settings: settings({ format: "plaintext", sceneDivider: "none" }),
    });
    expect(result).toContain("シーン1本文\nシーン2本文");
  });

  it("custom: カスタム区切り", () => {
    const result = generateExport({
      nodes,
      contentMap,
      checkedIds: checked,
      settings: settings({
        format: "plaintext",
        sceneDivider: "custom",
        sceneDividerCustom: "＊",
      }),
    });
    expect(result).toContain("シーン1本文\n\n＊\n\nシーン2本文");
  });

  it("フォルダー見出しを挟む場合、シーン区切りを省略", () => {
    // f1のs1、f2のs2 — フォルダー見出しが間に入る
    const f2 = makeFolder("f2", "第二部", null, "a1");
    const s2b = makeScene("s2b", "シーン2", "f2", "a0");
    const result = generateExport({
      nodes: [f1, s1, f2, s2b],
      contentMap: {
        s1: doc(para("シーン1本文")),
        s2b: doc(para("シーン2本文")),
      },
      checkedIds: new Set(["s1", "s2b"]),
      settings: settings({
        format: "plaintext",
        sceneDivider: "asterisks",
        folderHeading: true,
      }),
    });
    expect(result).not.toContain("* * *");
  });

  it("最後のシーンの後に区切りを挿入しない", () => {
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "plaintext", sceneDivider: "asterisks" }),
    });
    const lines = result.trimEnd().split("\n");
    const lastLine = lines[lines.length - 1];
    expect(lastLine).not.toContain("* * *");
  });
});

// ────────────────────────────────────────────────────────────────────
// シーンタイトル
// ────────────────────────────────────────────────────────────────────

describe("generateExport - scene titles", () => {
  it("none: タイトルを出力しない", () => {
    const s1 = makeScene("s1", "塔の麓");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ sceneTitle: "none" }),
    });
    expect(result).not.toContain("塔の麓");
  });

  it("plain: タイトルをそのまま出力", () => {
    const s1 = makeScene("s1", "塔の麓");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ sceneTitle: "plain" }),
    });
    expect(result).toContain("塔の麓");
  });

  it("bold (markdown): **タイトル**", () => {
    const s1 = makeScene("s1", "塔の麓");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "markdown", sceneTitle: "bold" }),
    });
    expect(result).toContain("**塔の麓**");
  });

  it("heading (markdown): フォルダー最深+1レベル", () => {
    // フォルダー深さ1(##) → シーンは ### レベル
    const f1 = makeFolder("f1", "第一部", null, "a0");
    const f2 = makeFolder("f2", "第1章", "f1", "a0");
    const s1 = makeScene("s1", "塔の麓", "f2", "a0");
    const result = generateExport({
      nodes: [f1, f2, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({
        format: "markdown",
        sceneTitle: "heading",
        folderHeading: true,
      }),
    });
    expect(result).toContain("### 塔の麓");
  });

  it("heading (markdown): フォルダーなし → # レベル", () => {
    const s1 = makeScene("s1", "塔の麓");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "markdown", sceneTitle: "heading" }),
    });
    expect(result).toContain("# 塔の麓");
  });
});

// ────────────────────────────────────────────────────────────────────
// ルビ
// ────────────────────────────────────────────────────────────────────

describe("generateExport - ruby styles", () => {
  function rubyDoc(): string {
    return JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "ruby", attrs: { base: "漢字", annotation: "かんじ" } },
          ],
        },
      ],
    });
  }

  it("html: <ruby> タグ", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: rubyDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "plaintext", rubyStyle: "html" }),
    });
    expect(result).toContain(
      "<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>",
    );
  });

  it("parentheses: 括弧表記", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: rubyDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "plaintext", rubyStyle: "parentheses" }),
    });
    expect(result).toContain("漢字(かんじ)");
  });

  it("aozora: 青空文庫形式", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: rubyDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "plaintext", rubyStyle: "aozora" }),
    });
    expect(result).toContain("｜漢字《かんじ》");
  });

  it("base: ルビなし（ベースのみ）", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: rubyDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "plaintext", rubyStyle: "base" }),
    });
    expect(result).toContain("漢字");
    expect(result).not.toContain("かんじ");
  });

  it("null (plaintext): 括弧表記をデフォルト選択", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: rubyDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "plaintext", rubyStyle: null }),
    });
    expect(result).toContain("漢字(かんじ)");
  });

  it("null (html): html タグをデフォルト選択", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: rubyDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "html", rubyStyle: null }),
    });
    expect(result).toContain("<ruby>漢字");
  });
});

// ────────────────────────────────────────────────────────────────────
// 傍点
// ────────────────────────────────────────────────────────────────────

describe("generateExport - emphasis dots styles", () => {
  function emphasisDoc(): string {
    return JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "重要",
              marks: [{ type: "emphasisDots" }],
            },
          ],
        },
      ],
    });
  }

  it("html: spanタグ", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: emphasisDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ emphasisDotsStyle: "html" }),
    });
    expect(result).toContain('<span class="emphasis-dots">重要</span>');
  });

  it("aozora: 青空文庫傍点注記", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: emphasisDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ emphasisDotsStyle: "aozora" }),
    });
    expect(result).toContain("重要［＃「重要」に傍点］");
  });

  it("double-angle: 二重山括弧", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: emphasisDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ emphasisDotsStyle: "double-angle" }),
    });
    expect(result).toContain("《《重要》》");
  });

  it("plain: そのまま出力", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: emphasisDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ emphasisDotsStyle: "plain" }),
    });
    expect(result).toContain("重要");
    expect(result).not.toContain("span");
    expect(result).not.toContain("傍点");
  });

  it("null (html format): html タグをデフォルト選択", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: emphasisDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "html", emphasisDotsStyle: null }),
    });
    expect(result).toContain("emphasis-dots");
  });

  it("null (plaintext): aozora をデフォルト選択", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: emphasisDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "plaintext", emphasisDotsStyle: null }),
    });
    expect(result).toContain("傍点");
  });
});

// ────────────────────────────────────────────────────────────────────
// シーンブレイク
// ────────────────────────────────────────────────────────────────────

describe("generateExport - scene break node", () => {
  function sceneBreakDoc(): string {
    return JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "前文" }] },
        { type: "sceneBreak" },
        { type: "paragraph", content: [{ type: "text", text: "後文" }] },
      ],
    });
  }

  it("asterisks: * * *", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: sceneBreakDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ sceneBreakStyle: "asterisks" }),
    });
    expect(result).toContain("前文\n* * *\n後文");
  });

  it("hr: ---", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: sceneBreakDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ sceneBreakStyle: "hr" }),
    });
    expect(result).toContain("前文\n---\n後文");
  });

  it("blank: 空行", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: sceneBreakDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ sceneBreakStyle: "blank" }),
    });
    expect(result).toContain("前文\n\n後文");
  });

  it("custom: カスタム文字列", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: sceneBreakDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ sceneBreakStyle: "custom", sceneBreakCustom: "✦" }),
    });
    expect(result).toContain("前文\n✦\n後文");
  });
});

// ────────────────────────────────────────────────────────────────────
// sortOrder による順序
// ────────────────────────────────────────────────────────────────────

describe("generateExport - sort order", () => {
  it("sortOrderに従ってシーンを並べる", () => {
    const s1 = makeScene("s1", "シーン1", null, "a1");
    const s2 = makeScene("s2", "シーン2", null, "a0"); // sortOrder小さい → 先
    const result = generateExport({
      nodes: [s1, s2],
      contentMap: {
        s1: doc(para("シーン1本文")),
        s2: doc(para("シーン2本文")),
      },
      checkedIds: new Set(["s1", "s2"]),
      settings: settings({ sceneDivider: "none" }),
    });
    const idx1 = result.indexOf("シーン2本文");
    const idx2 = result.indexOf("シーン1本文");
    expect(idx1).toBeLessThan(idx2);
  });
});
