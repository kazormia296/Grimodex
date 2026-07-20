import { describe, expect, it } from "vitest";
import { buildChunks, normalizeDocument, normalizeText } from "../src/index.js";

describe("scan-core deterministic preprocessing", () => {
  const source =
    "\uFEFF# 第一章\r\n\r\n葵は灯台へ向かった。  \r\n\r\n白い波が窓を叩く。\r\n\r\n## 第二章\r\n\r\n手紙が届いた。";

  it("normalizes BOM, line endings, and repeated horizontal whitespace", () => {
    expect(normalizeText(source)).toBe(
      "# 第一章\n\n葵は灯台へ向かった。\n\n白い波が窓を叩く。\n\n## 第二章\n\n手紙が届いた。",
    );
  });

  it("detects headings and produces stable paragraph IDs", () => {
    const first = normalizeDocument({
      title: "灯台",
      text: source,
      language: "ja",
    });
    const second = normalizeDocument({
      title: "灯台",
      text: source,
      language: "ja",
    });

    expect(first.sections.map((section) => section.title)).toEqual([
      "第一章",
      "第二章",
    ]);
    expect(first.paragraphs).toHaveLength(3);
    expect(first.paragraphs.map((paragraph) => paragraph.id)).toEqual(
      second.paragraphs.map((paragraph) => paragraph.id),
    );
    expect(first.source.fingerprint).toBe(second.source.fingerprint);
  });

  it("keeps chunk boundaries on paragraph boundaries and records overlap", () => {
    const document = normalizeDocument({
      title: "灯台",
      text: source,
      language: "ja",
    });
    const chunks = buildChunks(document, {
      maxCharacters: 24,
      overlapParagraphs: 1,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.paragraphIds.length > 0)).toBe(true);
    expect(chunks.every((chunk) => !chunk.text.includes("\n\n"))).toBe(true);
    expect(
      chunks.slice(1).some((chunk) => chunk.overlapParagraphIds.length > 0),
    ).toBe(true);
  });

  it("clips overlap so provider input never exceeds the configured limit", () => {
    const document = normalizeDocument({
      title: "Overlap",
      language: "ja",
      text: "# 第一章\n\n12345678\n\nabcdefgh\n\nijklmnop",
    });
    const chunks = buildChunks(document, {
      maxCharacters: 10,
      overlapParagraphs: 1,
    });
    expect(chunks.every((chunk) => chunk.text.length <= 10)).toBe(true);
  });

  it("rejects invalid chunk limits", () => {
    const document = normalizeDocument({
      title: "灯台",
      text: source,
      language: "ja",
    });

    expect(() => buildChunks(document, { maxCharacters: 0 })).toThrow(
      "maxCharacters",
    );
  });

  it("rejects a paragraph that cannot fit within the chunk limit", () => {
    const document = normalizeDocument({
      title: "長文",
      language: "ja",
      text: "# 第一章\n\n" + "あ".repeat(20),
    });

    expect(() => buildChunks(document, { maxCharacters: 10 })).toThrow(
      "paragraph exceeds maxCharacters",
    );
  });

  it("keeps empty headed sections so the editor seed does not lose structure", () => {
    const document = normalizeDocument({
      title: "空章",
      language: "ja",
      text: "# 第一章\n\n# 第二章\n\n本文",
    });

    expect(document.sections.map((section) => section.title)).toEqual([
      "第一章",
      "第二章",
    ]);
    expect(document.sections[0]?.paragraphIds).toEqual([]);
  });

  it("uses English fallback names for an untitled manuscript and unheaded continuation", () => {
    const untitled = normalizeDocument({
      title: "",
      language: "en",
      text: "A manuscript without a heading.",
    });
    const continued = normalizeDocument({
      title: "Draft",
      language: "en",
      text: "# Chapter One\n\nFirst scene.\n\n---\n\nSecond scene.",
    });

    expect(untitled.sections.map((section) => section.title)).toEqual([
      "Manuscript",
    ]);
    expect(continued.sections.map((section) => section.title)).toEqual([
      "Chapter One",
      "Next section",
    ]);
  });
});
