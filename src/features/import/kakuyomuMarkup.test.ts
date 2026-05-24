import { describe, it, expect } from "vitest";
import {
  kakuyomuBodyToProseMirror,
  parseKakuyomuSections,
  extractEpisodeBody,
} from "./kakuyomuMarkup";

function parseDoc(json: string) {
  return JSON.parse(json) as {
    type: string;
    content: {
      type: string;
      content?: unknown[];
    }[];
  };
}

describe("kakuyomuBodyToProseMirror", () => {
  it("converts plain text to one paragraph", () => {
    const doc = parseDoc(kakuyomuBodyToProseMirror("本文"));
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]?.content).toEqual([{ type: "text", text: "本文" }]);
  });

  it("converts auto-ruby on trailing kanji", () => {
    const doc = parseDoc(kakuyomuBodyToProseMirror("ルビ記法《きほう》"));
    const inline = doc.content[0]?.content ?? [];
    expect(inline).toEqual([
      { type: "text", text: "ルビ" },
      { type: "ruby", attrs: { base: "記法", annotation: "きほう" } },
    ]);
  });

  it("converts pipe ruby", () => {
    const doc = parseDoc(
      kakuyomuBodyToProseMirror("｜カタカナ《カタカナよみ》"),
    );
    const inline = doc.content[0]?.content ?? [];
    expect(inline).toEqual([
      {
        type: "ruby",
        attrs: { base: "カタカナ", annotation: "カタカナよみ" },
      },
    ]);
  });

  it("leaves katakana auto-ruby as literal", () => {
    const doc = parseDoc(kakuyomuBodyToProseMirror("カタカナ《よみ》"));
    const inline = doc.content[0]?.content ?? [];
    expect(inline).toEqual([{ type: "text", text: "カタカナ《よみ》" }]);
  });

  it("converts emphasis dots", () => {
    const doc = parseDoc(kakuyomuBodyToProseMirror("《《傍点》》"));
    const inline = doc.content[0]?.content ?? [];
    expect(inline).toEqual([
      {
        type: "text",
        text: "傍点",
        marks: [{ type: "emphasisDots" }],
      },
    ]);
  });

  it("handles innermost emphasis dots pair when nested", () => {
    const doc = parseDoc(kakuyomuBodyToProseMirror("《《a《《b》》c》》"));
    const inline = doc.content[0]?.content ?? [];
    expect(
      inline.some(
        (n) =>
          typeof n === "object" &&
          n !== null &&
          "type" in n &&
          n.type === "text" &&
          "text" in n &&
          n.text === "b" &&
          "marks" in n,
      ),
    ).toBe(true);
  });

  it("preserves full-width indent", () => {
    const doc = parseDoc(kakuyomuBodyToProseMirror("　全角インデント"));
    expect(doc.content[0]?.content?.[0]).toEqual({
      type: "text",
      text: "　全角インデント",
    });
  });

  it("normalizes CRLF and trims trailing blank lines", () => {
    const doc = parseDoc(kakuyomuBodyToProseMirror("line1\r\nline2\r\n\r\n"));
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]?.content?.[0]).toEqual({
      type: "text",
      text: "line1\nline2",
    });
  });

  it("splits paragraphs on blank lines", () => {
    const doc = parseDoc(kakuyomuBodyToProseMirror("p1\n\np2"));
    expect(doc.content).toHaveLength(2);
  });
});

describe("parseKakuyomuSections", () => {
  it("parses 【section】 blocks", () => {
    const text = "【タイトル】\r\n話1\r\n\r\n【本文（4行）】\r\n本文\r\n";
    const sections = parseKakuyomuSections(text);
    expect(sections.get("タイトル")).toBe("話1");
    expect(extractEpisodeBody(sections)).toBe("本文");
  });
});
