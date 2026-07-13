import { describe, it, expect } from "vitest";
import {
  buildVivliostyleHtml,
  VIVLIOSTYLE_THEME_FILENAME,
} from "./buildVivliostyleHtml";
import type { TreeNodeData } from "@/features/tree/treeStore";

// ────────────────────────────────────────────────────────────────────
// Vivliostyle CLI に渡す組版用 HTML の生成。
// 投稿サイト向け publish（generateExport の既定経路）とは独立した固定設定で、
// 実 <p> 要素・theme.css リンク・CSS 組版用 class を持つ HTML を出す。
// ────────────────────────────────────────────────────────────────────

function node(
  over: Partial<TreeNodeData> & Pick<TreeNodeData, "id" | "nodeType" | "title">,
): TreeNodeData {
  return {
    projectId: "p1",
    parentId: null,
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
    ...over,
  } as TreeNodeData;
}

function pmDoc(paragraphs: (string | null)[]): string {
  return JSON.stringify({
    type: "doc",
    content: paragraphs.map((text) =>
      text === null
        ? { type: "paragraph" }
        : { type: "paragraph", content: [{ type: "text", text }] },
    ),
  });
}

const folder = node({ id: "f1", nodeType: "folder", title: "第一章" });
const scene1 = node({
  id: "s1",
  nodeType: "scene",
  title: "S1",
  parentId: "f1",
});
const scene2 = node({
  id: "s2",
  nodeType: "scene",
  title: "S2",
  parentId: "f1",
});

function build(
  over: Partial<Parameters<typeof buildVivliostyleHtml>[0]> = {},
): string {
  return buildVivliostyleHtml({
    nodes: [folder, scene1, scene2],
    contentMap: {
      s1: pmDoc(["最初の段落。", "次の段落。"]),
      s2: pmDoc(["別シーンの本文。"]),
    },
    checkedIds: new Set(["f1", "s1", "s2"]),
    projectTitle: "テスト作品",
    projectLanguage: "ja",
    ...over,
  });
}

describe("buildVivliostyleHtml — 文書シェル", () => {
  it("DOCTYPE / lang / charset / title を持つ完全な HTML を出す", () => {
    const out = build();
    expect(out).toContain("<!DOCTYPE html>");
    expect(out).toContain('<html lang="ja">');
    expect(out).toContain('<meta charset="UTF-8">');
    expect(out).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'self'">`,
    );
    expect(out).toContain("<title>テスト作品</title>");
  });

  it("theme.css への <link> を持つ（インライン style ではない）", () => {
    const out = build();
    expect(out).toContain(
      `<link rel="stylesheet" href="${VIVLIOSTYLE_THEME_FILENAME}">`,
    );
  });

  it("タイトルの HTML 特殊文字をエスケープする", () => {
    const out = build({ projectTitle: 'A<B>&"C' });
    expect(out).toContain("<title>A&lt;B&gt;&amp;&quot;C</title>");
  });

  it("lang 属性をエスケープする（属性脱出によるタグ注入を防ぐ）", () => {
    const out = build({ projectLanguage: 'ja"><script>' });
    expect(out).not.toContain("<script>");
    expect(out).toContain('lang="ja">');
  });

  it("本文テキストの HTML 特殊文字をエスケープする（Chromium で実行される HTML への script 焼き込み防止）", () => {
    const out = build({
      contentMap: {
        s1: pmDoc(['<script>alert(1)</script> と A&B "引用"']),
      },
      checkedIds: new Set(["f1", "s1"]),
    });
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt; と A&amp;B &quot;引用&quot;",
    );
  });

  it("ルビの base/annotation もエスケープする", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "ruby",
              attrs: { base: "<b>x</b>", annotation: "<i>y</i>" },
            },
          ],
        },
      ],
    });
    const out = build({
      contentMap: { s1: doc },
      checkedIds: new Set(["f1", "s1"]),
    });
    expect(out).not.toContain("<b>x</b>");
    expect(out).toContain(
      "<ruby>&lt;b&gt;x&lt;/b&gt;<rp>(</rp><rt>&lt;i&gt;y&lt;/i&gt;</rt><rp>)</rp></ruby>",
    );
  });
});

describe("buildVivliostyleHtml — 本文構造", () => {
  it("段落を実 <p> 要素で包む", () => {
    const out = build();
    expect(out).toContain("<p>最初の段落。</p>");
    expect(out).toContain("<p>次の段落。</p>");
  });

  it('空段落（意図的な空行）は <p class="blank"> として保持する', () => {
    const out = build({
      contentMap: { s1: pmDoc(["前", null, "後"]) },
      checkedIds: new Set(["f1", "s1"]),
    });
    expect(out).toContain('<p class="blank"></p>');
  });

  it("hardBreak は <br> になる", () => {
    const doc = JSON.stringify({
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
    const out = build({
      contentMap: { s1: doc },
      checkedIds: new Set(["f1", "s1"]),
    });
    expect(out).toContain("<p>一行目<br>二行目</p>");
  });

  it("章フォルダーは見出し要素になる", () => {
    const out = build();
    expect(out).toMatch(/<h1>第一章<\/h1>/);
  });

  it("シーン間に scene-break 区切りを挿入する", () => {
    const out = build();
    expect(out).toContain('<p class="scene-break">');
    // s1 本文 → 区切り → s2 本文 の順
    const i1 = out.indexOf("次の段落。");
    const ib = out.indexOf('<p class="scene-break">');
    const i2 = out.indexOf("別シーンの本文。");
    expect(i1).toBeLessThan(ib);
    expect(ib).toBeLessThan(i2);
  });
});

describe("buildVivliostyleHtml — CSS 組版向け記法", () => {
  it("ルビは <ruby> タグで出す", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "ruby", attrs: { base: "薔薇", annotation: "ばら" } },
          ],
        },
      ],
    });
    const out = build({
      contentMap: { s1: doc },
      checkedIds: new Set(["f1", "s1"]),
    });
    // <rp> はルビ非対応リーダー向けフォールバック括弧（EPUB 互換に必須）
    expect(out).toContain("<ruby>薔薇<rp>(</rp><rt>ばら</rt><rp>)</rp></ruby>");
  });

  it("傍点は emphasis-dots class の span で出す", () => {
    const doc = JSON.stringify({
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
    const out = build({
      contentMap: { s1: doc },
      checkedIds: new Set(["f1", "s1"]),
    });
    expect(out).toContain('<span class="emphasis-dots">重要</span>');
  });

  it("縦中横は tcy class の span で出す", () => {
    const out = build({
      contentMap: { s1: pmDoc(["Ｂ29を確認"]) },
      checkedIds: new Set(["f1", "s1"]),
    });
    expect(out).toContain('Ｂ<span class="tcy">29</span>を確認');
  });
});
