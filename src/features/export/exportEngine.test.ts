import { describe, it, expect } from "vitest";
import { generateExport, renderPmDocToMarkdown } from "./exportEngine";
import { renderRubyText } from "./rubyFormats";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { ExportSettings, RubyStyle } from "./types";
import { DEFAULT_EXPORT_SETTINGS, defaultRubyStyle } from "./types";

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

    intent: null,
    sortOrder,
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

    intent: null,
    sortOrder,
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

function makeNote(id: string, parentId: string | null = null): TreeNodeData {
  return {
    id,
    projectId: "p1",
    parentId,
    nodeType: "note",
    title: "note",
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

describe("generateExport - folder headings (pixiv-chapter)", () => {
  it("pixiv-chapter フォーマット: [chapter:タイトル]", () => {
    const f1 = makeFolder("f1", "第一部");
    const s1 = makeScene("s1", "シーン1", "f1");
    const result = generateExport({
      nodes: [f1, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({
        format: "plaintext",
        folderHeading: true,
        folderHeadingFormat: "pixiv-chapter",
      }),
    });
    expect(result).toContain("[chapter:第一部]");
    expect(result).not.toContain("■");
  });

  it("pixiv-chapter + pixivChapterNewpage=true: [newpage] が章前に挿入される", () => {
    const f1 = makeFolder("f1", "第一部");
    const s1 = makeScene("s1", "シーン1", "f1");
    const result = generateExport({
      nodes: [f1, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({
        format: "plaintext",
        folderHeading: true,
        folderHeadingFormat: "pixiv-chapter",
        pixivChapterNewpage: true,
      }),
    });
    expect(result).toContain("[newpage]");
    expect(result).toContain("[chapter:第一部]");
    // [newpage] が [chapter:] より先に出る
    expect(result.indexOf("[newpage]")).toBeLessThan(
      result.indexOf("[chapter:"),
    );
  });

  it("pixiv-chapter + pixivChapterNewpage=false: [newpage] は出ない", () => {
    const f1 = makeFolder("f1", "第一部");
    const s1 = makeScene("s1", "シーン1", "f1");
    const result = generateExport({
      nodes: [f1, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({
        format: "plaintext",
        folderHeading: true,
        folderHeadingFormat: "pixiv-chapter",
        pixivChapterNewpage: false,
      }),
    });
    expect(result).toContain("[chapter:第一部]");
    expect(result).not.toContain("[newpage]");
  });

  it("pixiv-chapter は plaintext 専用で markdown/html では standard に戻る", () => {
    const f1 = makeFolder("f1", "第一部");
    const s1 = makeScene("s1", "シーン1", "f1");
    const md = generateExport({
      nodes: [f1, s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({
        format: "markdown",
        folderHeading: true,
        folderHeadingFormat: "pixiv-chapter",
      }),
    });
    expect(md).toContain("# 第一部");
    expect(md).not.toContain("[chapter:");
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
    expect(result).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'">`,
    );
    expect(result).toContain("<title>My Novel</title>");
    expect(result).toContain("<body>");
    expect(result).toContain("</body>");
  });

  it("lang 属性を BCP 47 に限定し、属性脱出をフォールバックする", () => {
    const s1 = makeScene("s1", "シーン1");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "html" }),
      projectLanguage: 'ja"><script>alert(1)</script>',
    });
    expect(result).toContain('<html lang="ja">');
    expect(result).not.toContain("<script>");
  });

  it("HTMLリンクは安全なschemeと相対URLだけを出力する", () => {
    const s1 = makeScene("s1", "シーン1");
    const linked = (href: string): string =>
      JSON.stringify({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "link",
                marks: [{ type: "link", attrs: { href } }],
              },
            ],
          },
        ],
      });

    for (const href of [
      "https://example.com/page",
      "mailto:writer@example.com",
      "/chapter/1",
      "#scene-1",
    ]) {
      const result = generateExport({
        nodes: [s1],
        contentMap: { s1: linked(href) },
        checkedIds: new Set(["s1"]),
        settings: settings({ format: "html" }),
      });
      expect(result).toContain(`<a href="${href}">link</a>`);
    }

    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "//evil.example/collect",
      '"><script>alert(1)</script>',
    ]) {
      const result = generateExport({
        nodes: [s1],
        contentMap: { s1: linked(href) },
        checkedIds: new Set(["s1"]),
        settings: settings({ format: "html" }),
      });
      expect(result).not.toContain("<a ");
      expect(result).not.toContain("<script>");
      expect(result).toContain("link");
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// codeBlock serialization (format-gated; HTML must escape, not fence)
// ────────────────────────────────────────────────────────────────────

describe("generateExport - codeBlock serialization", () => {
  function codeBlockDoc(code: string, language = ""): string {
    return JSON.stringify({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language },
          content: [{ type: "text", text: code }],
        },
      ],
    });
  }

  it("html: code is escaped and wrapped in <pre><code>, not raw ``` fences", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: codeBlockDoc("</p><script>alert(1)</script>") },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "html" }),
      projectTitle: "Doc",
      projectLanguage: "ja",
    });
    // 本文の生 HTML 注入を防ぐ: script/閉じタグは escape される
    expect(result).toContain(
      "<pre><code>&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>",
    );
    expect(result).not.toContain("<script>alert(1)</script>");
    // Markdown フェンスが HTML 本文に漏れない
    expect(result).not.toContain("```");
  });

  it("html: language becomes an escaped class attribute", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: codeBlockDoc("x = 1", '"><img src=x>') },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "html" }),
      projectTitle: "Doc",
      projectLanguage: "ja",
    });
    expect(result).toContain(
      '<code class="language-&quot;&gt;&lt;img src=x&gt;">',
    );
    expect(result).not.toContain('"><img src=x>');
  });

  it("markdown: still emits triple-backtick fences (unchanged)", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: codeBlockDoc("const a = 1;", "ts") },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "markdown" }),
    });
    expect(result).toContain("```ts\nconst a = 1;\n```");
  });
});

// ────────────────────────────────────────────────────────────────────
// Empty paragraph serialization (format-gated)
// ────────────────────────────────────────────────────────────────────

describe("empty paragraph node serialization is format-gated", () => {
  // A doc whose middle paragraph is empty — what `normalizeImportedMarkdown`
  // produces for 2+ consecutive user-authored blank lines.
  function docWithEmpty(): string {
    return JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "A" }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "B" }] },
      ],
    });
  }

  it("markdown: empty paragraph → `<p></p>` (re-parses to the same node)", () => {
    const s1 = makeScene("s1", "scene");
    const out = generateExport({
      nodes: [s1],
      contentMap: { s1: docWithEmpty() },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "markdown" }),
    });
    // Marker present once between A and B.
    expect(out).toMatch(/A\n\n<p><\/p>\n\nB/);
  });

  it("plaintext: empty paragraph → blank line (no literal `<p></p>` in user output)", () => {
    const s1 = makeScene("s1", "scene");
    const out = generateExport({
      nodes: [s1],
      contentMap: { s1: docWithEmpty() },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "plaintext" }),
    });
    expect(out).not.toContain("<p></p>");
  });

  it("html: empty paragraph does not leak literal `<p></p>` into the document body", () => {
    const s1 = makeScene("s1", "scene");
    const out = generateExport({
      nodes: [s1],
      contentMap: { s1: docWithEmpty() },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "html" }),
      projectTitle: "Doc",
      projectLanguage: "ja",
    });
    // HTML export wraps each scene in a styled section; the body must not
    // contain a stray `<p></p>` marker that came from the markdown round-trip.
    expect(out).not.toContain("<p></p>");
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
  const BASE = "漢字";
  const ANNO = "かんじ";

  function rubyDoc(base = BASE, annotation = ANNO): string {
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

  function exportWithRubyStyle(rubyStyle: RubyStyle, doc = rubyDoc()): string {
    const s1 = makeScene("s1", "S");
    return generateExport({
      nodes: [s1],
      contentMap: { s1: doc },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "plaintext", rubyStyle }),
    });
  }

  const ALL_RUBY_STYLES: RubyStyle[] = [
    "html",
    "parentheses",
    "aozora",
    "aozora-auto",
    "narou-parens",
    "hash-underscore",
    "rb-bracket",
    "mediawiki",
    "wikiwiki",
    "denden",
    "denden-chars",
    "renpy",
    "game-engine",
    "base",
  ];

  it.each(ALL_RUBY_STYLES)(
    "rubyStyle %s: export pipeline outputs expected notation",
    (rubyStyle) => {
      const result = exportWithRubyStyle(rubyStyle);
      expect(result).toContain(renderRubyText(BASE, ANNO, rubyStyle));
    },
  );

  it("base: annotation text is omitted", () => {
    const result = exportWithRubyStyle("base");
    expect(result).toContain(BASE);
    expect(result).not.toContain(ANNO);
  });

  it("aozora-auto: no fullwidth pipe prefix", () => {
    const result = exportWithRubyStyle("aozora-auto");
    expect(result).toContain("漢字《かんじ》");
    expect(result).not.toContain("｜漢字");
  });

  it("denden-chars: per-character when base and annotation lengths match", () => {
    const result = exportWithRubyStyle("denden-chars", rubyDoc("対象", "ルビ"));
    expect(result).toContain("{対象|ル|ビ}");
  });

  it("game-engine: per-character when base and annotation lengths match", () => {
    const result = exportWithRubyStyle("game-engine", rubyDoc("対象", "ルビ"));
    expect(result).toContain("[ruby text=ル]対[ruby text=ビ]象");
  });

  it("null (plaintext): defaults to parentheses", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: rubyDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "plaintext", rubyStyle: null }),
    });
    expect(result).toContain(
      renderRubyText(BASE, ANNO, defaultRubyStyle("plaintext")),
    );
  });

  it("null (html): defaults to html ruby tag", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: rubyDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "html", rubyStyle: null }),
    });
    expect(result).toContain(
      renderRubyText(BASE, ANNO, defaultRubyStyle("html")),
    );
  });

  it("null (markdown): defaults to html ruby tag", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: rubyDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "markdown", rubyStyle: null }),
    });
    expect(result).toContain(
      renderRubyText(BASE, ANNO, defaultRubyStyle("markdown")),
    );
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

  it("narou-emphasis-batch: |語《・・》 形式（語の長さ分の中黒）", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: emphasisDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ emphasisDotsStyle: "narou-emphasis-batch" }),
    });
    expect(result).toContain("|重要《・・》");
  });

  it("narou-emphasis-per-char: 1文字ごとに |字《・》", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: emphasisDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ emphasisDotsStyle: "narou-emphasis-per-char" }),
    });
    expect(result).toContain("|重《・》|要《・》");
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

  // Block-level children of `doc` are separated by a blank line so the next
  // markdown parse keeps them as separate paragraphs (rather than collapsing
  // into one soft-break-joined paragraph). Scene break markers are no
  // exception — they must be surrounded by blank lines on round-trip.
  it("asterisks: * * *", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: sceneBreakDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ sceneBreakStyle: "asterisks" }),
    });
    expect(result).toContain("前文\n\n* * *\n\n後文");
  });

  it("hr: ---", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: sceneBreakDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ sceneBreakStyle: "hr" }),
    });
    expect(result).toContain("前文\n\n---\n\n後文");
  });

  it("blank: 空行", () => {
    const s1 = makeScene("s1", "S");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: sceneBreakDoc() },
      checkedIds: new Set(["s1"]),
      settings: settings({ sceneBreakStyle: "blank" }),
    });
    // "blank" style emits an empty sceneBreak — doc join adds the blank line.
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
    expect(result).toContain("前文\n\n✦\n\n後文");
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

// ────────────────────────────────────────────────────────────────────
// Beat ノードの Export 挙動
// ────────────────────────────────────────────────────────────────────

function sceneBeat(id: string, ...texts: string[]): object {
  return {
    type: "sceneBeat",
    attrs: { id, beatType: "free", pov: null, collapsed: false },
    content: texts.map((t) => ({ type: "text", text: t })),
  };
}

function generatedProseBlock(beatId: string, ...paras: object[]): object {
  return {
    type: "generatedProseBlock",
    attrs: { beatId, modified: false },
    content: paras,
  };
}

describe("generateExport - Beat ノード", () => {
  it("sceneBeat ノードは export 出力に含まれない", () => {
    const s1 = makeScene("s1", "シーン1");
    const result = generateExport({
      nodes: [s1],
      contentMap: {
        s1: doc(sceneBeat("b1", "[slow down]", "ここで何か起こる")),
      },
      checkedIds: new Set(["s1"]),
      settings: settings(),
    });
    expect(result).toBe("");
    expect(result).not.toContain("slow down");
    expect(result).not.toContain("ここで何か起こる");
  });

  it("generatedProseBlock は中身の段落だけが出力される（unwrap）", () => {
    const s1 = makeScene("s1", "シーン1");
    const result = generateExport({
      nodes: [s1],
      contentMap: {
        s1: doc(generatedProseBlock("b1", para("生成されたprose文章"))),
      },
      checkedIds: new Set(["s1"]),
      settings: settings(),
    });
    expect(result).toBe("生成されたprose文章\n");
  });

  it("Beat + generatedProseBlock + 通常段落が混在する場合", () => {
    const s1 = makeScene("s1", "シーン1");
    const result = generateExport({
      nodes: [s1],
      contentMap: {
        s1: doc(
          para("冒頭の通常文"),
          sceneBeat("b1", "ビート指示テキスト"),
          generatedProseBlock("b1", para("AI生成prose")),
          para("通常の続き"),
        ),
      },
      checkedIds: new Set(["s1"]),
      settings: settings(),
    });
    expect(result).not.toContain("ビート指示テキスト");
    expect(result).toContain("冒頭の通常文");
    expect(result).toContain("AI生成prose");
    expect(result).toContain("通常の続き");
  });

  it("generatedProseBlock が複数段落を含む場合、各段落が独立して出力される", () => {
    const s1 = makeScene("s1", "シーン1");
    const result = generateExport({
      nodes: [s1],
      contentMap: {
        s1: doc(generatedProseBlock("b1", para("一段落目"), para("二段落目"))),
      },
      checkedIds: new Set(["s1"]),
      settings: settings(),
    });
    expect(result).toContain("一段落目");
    expect(result).toContain("二段落目");
  });
});

// ────────────────────────────────────────────────────────────────────
// synthetic-echo シーン見出しの抑制（bug #2 retrospective）
//
// `## 概要\n\nbody` を `parseMarkdownSingle` で取り込むと、本文を救うために
// chapter と同名の synthetic scene が作られる (markdownParser.ts:71)。
// この状態で `sceneTitle: "heading"` のままエクスポートすると
// `## 概要\n### 概要\nbody` のような重複見出しが出力され、入力と構造が一致
// しない。chapter heading が出力される（= folderHeading=true）かつ folder
// 直下の (checked) scene が 1 件のみ・タイトル一致のときに限り、scene 側
// の見出しを抑制する。ユーザーが意図して同名にした場合も丸ごと idempotent
// な round-trip になるので副作用は限定的。
// ────────────────────────────────────────────────────────────────────

describe("generateExport - synthetic-echo scene heading suppression", () => {
  it("synthetic-echo (folder + single scene with same title) suppresses scene heading", () => {
    // 入力相当: `## 概要\n\nbody` を import した tree
    const f = makeFolder("f1", "概要");
    const s1 = makeScene("s1", "概要", "f1");
    const result = generateExport({
      nodes: [f, s1],
      contentMap: { s1: doc(para("body")) },
      checkedIds: new Set(["s1"]),
      settings: settings({
        format: "markdown",
        folderHeading: true,
        sceneTitle: "heading",
      }),
    });
    expect(result).toContain("# 概要"); // folder heading は出る (depth 0 → #)
    expect(result).not.toContain("## 概要"); // 抑制対象の scene heading (folderDepth 1 → ##)
    // Idempotent: re-import → folder "概要" + scene "概要" (synthetic) と同じ構造になる
  });

  it("folderHeading=false の場合は scene heading を抑制しない（タイトル完全喪失を防ぐ）", () => {
    const f = makeFolder("f1", "概要");
    const s1 = makeScene("s1", "概要", "f1");
    const result = generateExport({
      nodes: [f, s1],
      contentMap: { s1: doc(para("body")) },
      checkedIds: new Set(["s1"]),
      settings: settings({
        format: "markdown",
        folderHeading: false,
        sceneTitle: "heading",
      }),
    });
    // folder heading が出ていないので scene heading が唯一のタイトル → 残す
    expect(result).toContain("# 概要");
    expect(result).toContain("body");
  });

  it("同 folder 配下に scene が 2 件以上ある場合は抑制しない", () => {
    const f = makeFolder("f1", "概要");
    const s1 = makeScene("s1", "概要", "f1", "a0");
    const s2 = makeScene("s2", "別のシーン", "f1", "a1");
    const result = generateExport({
      nodes: [f, s1, s2],
      contentMap: {
        s1: doc(para("body1")),
        s2: doc(para("body2")),
      },
      checkedIds: new Set(["s1", "s2"]),
      settings: settings({
        format: "markdown",
        folderHeading: true,
        sceneTitle: "heading",
      }),
    });
    // sibling が複数なら個々の scene heading は必要（区別できなくなる）
    expect(result).toContain("# 概要");
    expect(result).toContain("## 概要"); // s1 scene heading は残る
    expect(result).toContain("## 別のシーン");
  });

  it("scene title が folder title と異なる場合は抑制しない", () => {
    const f = makeFolder("f1", "概要");
    const s1 = makeScene("s1", "オープニング", "f1");
    const result = generateExport({
      nodes: [f, s1],
      contentMap: { s1: doc(para("body")) },
      checkedIds: new Set(["s1"]),
      settings: settings({
        format: "markdown",
        folderHeading: true,
        sceneTitle: "heading",
      }),
    });
    expect(result).toContain("# 概要");
    expect(result).toContain("## オープニング");
  });

  it("sceneTitle=bold でも echo は抑制される (heading 限定ではなく全 sceneTitle 形式)", () => {
    const f = makeFolder("f1", "概要");
    const s1 = makeScene("s1", "概要", "f1");
    const result = generateExport({
      nodes: [f, s1],
      contentMap: { s1: doc(para("body")) },
      checkedIds: new Set(["s1"]),
      settings: settings({
        format: "markdown",
        folderHeading: true,
        sceneTitle: "bold",
      }),
    });
    expect(result).toContain("# 概要");
    expect(result).not.toContain("**概要**"); // bold 形式の echo も抑制
  });
});

// ────────────────────────────────────────────────────────────────────
// table cell escaping (CodeQL js/incomplete-sanitization)
// ────────────────────────────────────────────────────────────────────

describe("generateExport - table cell escaping", () => {
  function tableDoc(rows: string[][]): string {
    return JSON.stringify({
      type: "doc",
      content: [
        {
          type: "table",
          content: rows.map((cells, i) => ({
            type: "tableRow",
            content: cells.map((text) => ({
              type: i === 0 ? "tableHeader" : "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text }],
                },
              ],
            })),
          })),
        },
      ],
    });
  }

  it("リテラル `|` は `\\|` に escape される", () => {
    const s1 = makeScene("s1", "t");
    const result = generateExport({
      nodes: [s1],
      contentMap: {
        s1: tableDoc([
          ["h1", "h2"],
          ["a|b", "c"],
        ]),
      },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "markdown" }),
    });
    expect(result).toContain("| a\\|b | c |");
  });

  it("リテラル `\\` は `\\\\` に escape される（pipe escape の崩壊を防ぐ）", () => {
    const s1 = makeScene("s1", "t");
    const result = generateExport({
      nodes: [s1],
      contentMap: {
        s1: tableDoc([
          ["h1", "h2"],
          ["a\\b", "c"],
        ]),
      },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "markdown" }),
    });
    expect(result).toContain("| a\\\\b | c |");
  });

  it("`\\|` (backslash の直後に pipe) は `\\\\\\|` になり、cell が早期 split しない", () => {
    // 旧実装は `\\|` を出力 → `\\` で backslash escape が消費され `|` が cell split
    // 新実装は backslash を先に escape して `\\\|` → `\\` (literal `\`) + `\|` (escaped `|`)
    const s1 = makeScene("s1", "t");
    const result = generateExport({
      nodes: [s1],
      contentMap: {
        s1: tableDoc([
          ["h1", "h2"],
          ["a\\|b", "c"],
        ]),
      },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "markdown" }),
    });
    expect(result).toContain("| a\\\\\\|b | c |");
  });

  it("複数段落セルは改行が `<br>` になり行を壊さない", () => {
    const s1 = makeScene("s1", "t");
    const docJson = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "h1" }],
                    },
                  ],
                },
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "h2" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "p1" }],
                    },
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "p2" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "c" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: docJson },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "markdown" }),
    });
    expect(result).toContain("| p1<br>p2 | c |");
    // 生の改行が残ると再パースで行が割れる/早期終了する
    expect(result).not.toContain("p1\np2");
  });

  it("hardBreak を含むセルは `<br>` になり行を壊さない", () => {
    const s1 = makeScene("s1", "t");
    const docJson = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "h1" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        { type: "text", text: "a" },
                        { type: "hardBreak" },
                        { type: "text", text: "b" },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: docJson },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "markdown" }),
    });
    expect(result).toContain("| a<br>b |");
  });
});

// ────────────────────────────────────────────────────────────────────
// @mention ノード (Item B: 消失バグ回帰ガード)
// ────────────────────────────────────────────────────────────────────

/** `@mention` インラインアトムの PM JSON。 */
function mention(id: string, label?: string): object {
  return {
    type: "mention",
    attrs: {
      id,
      label: label ?? null,
      role: "mentioned",
      kind: "codex",
    },
  };
}

/** mention を混在させた段落。 */
function paraWith(...parts: object[]): object {
  return { type: "paragraph", content: parts };
}

describe("generateExport - @mention ノード", () => {
  it("resolver 無し → 焼き込み label を素の名前で出力 (空文字に落ちない)", () => {
    const s1 = makeScene("s1", "シーン1");
    const docJson = doc(
      paraWith(
        { type: "text", text: "「やあ」と" },
        mention("codex-akira", "アキラ"),
        { type: "text", text: "が言った。" },
      ),
    );
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: docJson },
      checkedIds: new Set(["s1"]),
      settings: settings(),
    });
    expect(result).toBe("「やあ」とアキラが言った。\n");
  });

  it("resolver あり → 現在名に追従 (改名波及)", () => {
    const s1 = makeScene("s1", "シーン1");
    const docJson = doc(
      paraWith(mention("codex-akira", "アキラ"), {
        type: "text",
        text: "は振り向いた。",
      }),
    );
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: docJson },
      checkedIds: new Set(["s1"]),
      settings: settings(),
      resolveMentionName: (id, fallback) =>
        id === "codex-akira" ? "アキト" : fallback,
    });
    expect(result).toBe("アキトは振り向いた。\n");
  });

  it("label が無い mention → id にフォールバック", () => {
    const s1 = makeScene("s1", "シーン1");
    const docJson = doc(paraWith(mention("codex-x")));
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: docJson },
      checkedIds: new Set(["s1"]),
      settings: settings(),
    });
    expect(result).toBe("codex-x\n");
  });

  it("resolver が未知 id にフォールバック値を返せば label を維持", () => {
    const s1 = makeScene("s1", "シーン1");
    const docJson = doc(paraWith(mention("codex-deleted", "ナナ")));
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: docJson },
      checkedIds: new Set(["s1"]),
      settings: settings(),
      // store にいない id は fallback(label)を返す resolver
      resolveMentionName: (_id, fallback) => fallback,
    });
    expect(result).toBe("ナナ\n");
  });
});

describe("renderPmDocToMarkdown - @mention (file-backed write-back)", () => {
  it("mention が空文字に落ちず label のプレーンテキストとして残る", () => {
    const docJson = doc(
      paraWith(mention("codex-akira", "アキラ"), {
        type: "text",
        text: "の声がした。",
      }),
    );
    const md = renderPmDocToMarkdown(docJson);
    expect(md).toBe("アキラの声がした。\n");
  });
});

describe("generateExport - paragraph indentation", () => {
  it("none preserves the existing plaintext output", () => {
    const s1 = makeScene("s1", "シーン1");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ paragraphIndent: "none" }),
    });
    expect(result).toBe("本文\n");
  });

  it("fullwidth-space prefixes every top-level non-empty paragraph", () => {
    const s1 = makeScene("s1", "シーン1");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: doc(para("第一段落"), para("第二段落")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ paragraphIndent: "fullwidth-space" }),
    });
    expect(result).toBe("\u3000第一段落\n\n\u3000第二段落\n");
  });

  it("fullwidth-space does not duplicate author-entered leading whitespace", () => {
    const s1 = makeScene("s1", "シーン1");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: doc(para("\u3000既入力")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ paragraphIndent: "fullwidth-space" }),
    });
    expect(result).toBe("\u3000既入力\n");
  });

  it("fullwidth-space does not indent paragraphs nested in a list", () => {
    const s1 = makeScene("s1", "シーン1");
    const list = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [para("項目")],
            },
          ],
        },
      ],
    });
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: list },
      checkedIds: new Set(["s1"]),
      settings: settings({ paragraphIndent: "fullwidth-space" }),
    });
    expect(result).toContain("- 項目");
    expect(result).not.toContain("- \u3000項目");
  });

  it("generated prose wrappers keep top-level paragraph indentation", () => {
    const s1 = makeScene("s1", "シーン1");
    const generated = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "generatedProseBlock",
          content: [para("生成本文")],
        },
      ],
    });
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: generated },
      checkedIds: new Set(["s1"]),
      settings: settings({ paragraphIndent: "fullwidth-space" }),
    });
    expect(result).toBe("\u3000生成本文\n");
  });

  it("css emits real HTML paragraphs, hard breaks, and the indent rule", () => {
    const s1 = makeScene("s1", "シーン1");
    const content = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "一行目" },
            { type: "hardBreak" },
            { type: "text", text: "二行目" },
          ],
        },
      ],
    });
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: content },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "html", paragraphIndent: "css" }),
    });
    expect(result).toContain(
      '<p class="paragraph-indent">一行目<br>二行目</p>',
    );
    expect(result).toContain(".paragraph-indent { text-indent: 1em; }");
  });

  it("css does not double-indent author-entered leading whitespace", () => {
    const s1 = makeScene("s1", "シーン1");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: doc(para("\u3000既入力")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "html", paragraphIndent: "css" }),
    });
    expect(result).toContain("<p>\u3000既入力</p>");
    expect(result).not.toContain(
      '<p class="paragraph-indent">\u3000既入力</p>',
    );
  });

  it("css is a no-op for non-HTML output", () => {
    const s1 = makeScene("s1", "シーン1");
    const result = generateExport({
      nodes: [s1],
      contentMap: { s1: doc(para("本文")) },
      checkedIds: new Set(["s1"]),
      settings: settings({ format: "plaintext", paragraphIndent: "css" }),
    });
    expect(result).toBe("本文\n");
  });
});
