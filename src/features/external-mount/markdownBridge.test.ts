// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderPmDocToMarkdown } from "@/features/export/exportEngine";
import { pmJsonToMarkdown, markdownToPmJson } from "./markdownBridge";

describe("markdownBridge", () => {
  it("round-trips basic paragraph markdown", () => {
    const md = "Hello **world**.\n";
    const json = markdownToPmJson(md);
    const out = pmJsonToMarkdown(json);
    expect(out).toContain("Hello");
    expect(out).toContain("**world**");
  });

  it("round-trips headings and lists", () => {
    const md = "# Title\n\n- one\n- two\n";
    const json = markdownToPmJson(md);
    const out = pmJsonToMarkdown(json);
    expect(out).toContain("# Title");
    expect(out).toMatch(/one/);
  });

  it("round-trips task lists with checkbox syntax", () => {
    const md = "- [ ] todo\n- [x] done\n";
    const json = markdownToPmJson(md);
    const out = pmJsonToMarkdown(json);
    expect(out).toContain("- [ ] todo");
    expect(out).toContain("- [x] done");
  });

  it("round-trips fenced code blocks", () => {
    const md = "```ts\nconst x = 1;\n```\n";
    const json = markdownToPmJson(md);
    const out = pmJsonToMarkdown(json);
    expect(out).toContain("```ts");
    expect(out).toContain("const x = 1;");
  });

  it("round-trips markdown links", () => {
    const md = "[Example](https://example.com)\n";
    const json = markdownToPmJson(md);
    const out = pmJsonToMarkdown(json);
    expect(out).toContain("[Example](https://example.com)");
  });

  it("strips trailing empty paragraphs on import", () => {
    const json = markdownToPmJson("- [ ] item\n");
    const content = json.content as Array<{ type: string }>;
    expect(content.at(-1)?.type).toBe("taskList");
  });

  describe("Setext H2 suppression (`paragraph\\n---` → paragraph + HR)", () => {
    function nodeTypes(doc: Record<string, unknown>): string[] {
      return (doc.content as Array<Record<string, unknown>>).map(
        (n) => n.type as string,
      );
    }

    it("does NOT promote prior paragraph to H2 when --- follows without blank line", () => {
      const md =
        "Beatシステムは、シーン内の構造単位「ビート」を扱う。\n---\n## 次の章\n";
      const doc = markdownToPmJson(md);
      const types = nodeTypes(doc);
      expect(types).toEqual(["paragraph", "horizontalRule", "heading"]);
    });

    it("treats multi-line paragraph + --- as paragraph + HR (not H2 of joined text)", () => {
      const md = [
        "First line.",
        "Second line.",
        "Third line.",
        "---",
        "## Next",
        "",
      ].join("\n");
      const doc = markdownToPmJson(md);
      const types = nodeTypes(doc);
      expect(types).toEqual(["paragraph", "horizontalRule", "heading"]);
      const para = (doc.content as Array<Record<string, unknown>>)[0]!;
      const text = (para.content as Array<{ text?: string }>)
        .map((c) => c.text ?? "")
        .join("");
      // Soft breaks collapse to spaces — that's standard CommonMark and
      // matches Obsidian's reading view; explicitly assert paragraph wins.
      expect(text).toContain("First line.");
      expect(text).toContain("Third line.");
    });

    it("preserves --- as HR when already separated by blank line", () => {
      const md = "Para.\n\n---\n\nNext para.\n";
      const doc = markdownToPmJson(md);
      const types = nodeTypes(doc);
      expect(types).toEqual(["paragraph", "horizontalRule", "paragraph"]);
    });

    it("does not touch --- inside fenced code blocks", () => {
      const md = "```\nfoo\n---\nbar\n```\n";
      const doc = markdownToPmJson(md);
      const types = nodeTypes(doc);
      expect(types).toEqual(["codeBlock"]);
    });

    it("leaves short Setext (--, =====) underlines alone", () => {
      // 2 dashes — uncommon but unambiguously Setext H2; do not normalize.
      const setextH1 = "Title\n=====\n";
      const setextH1Doc = markdownToPmJson(setextH1);
      const types = nodeTypes(setextH1Doc);
      expect(types[0]).toBe("heading");
      expect(
        (
          (setextH1Doc.content as Array<Record<string, unknown>>)[0]!
            .attrs as Record<string, unknown>
        ).level,
      ).toBe(1);
    });

    it("handles multiple consecutive --- separators correctly", () => {
      const md = "A\n---\nB\n---\nC\n";
      const doc = markdownToPmJson(md);
      const types = nodeTypes(doc);
      expect(types).toEqual([
        "paragraph",
        "horizontalRule",
        "paragraph",
        "horizontalRule",
        "paragraph",
      ]);
    });
  });

  describe("breaks: true (Obsidian-default line breaks)", () => {
    function nodeTypesInFirstPara(doc: Record<string, unknown>): string[] {
      const first = (doc.content as Array<Record<string, unknown>>)[0]!;
      return (first.content as Array<Record<string, unknown>>).map(
        (n) => n.type as string,
      );
    }

    it("single newline inside paragraph becomes hardBreak (not soft space)", () => {
      const md = "hohohohoho\nyoyouy\nuiuiui\n";
      const doc = markdownToPmJson(md);
      const inner = nodeTypesInFirstPara(doc);
      expect(inner).toEqual(["text", "hardBreak", "text", "hardBreak", "text"]);
    });

    it("blank line still produces a separate paragraph (not a hardBreak)", () => {
      const md = "Para A\n\nPara B\n";
      const doc = markdownToPmJson(md);
      const types = (doc.content as Array<{ type: string }>).map((n) => n.type);
      expect(types).toEqual(["paragraph", "paragraph"]);
    });

    it("full round-trip: a\\nb\\n\\nc → a\\nb\\n\\nc (hardBreak preserved, paragraph preserved)", () => {
      const md = "a\nb\n\nc\n";
      const pm = markdownToPmJson(md);
      const back = pmJsonToMarkdown(pm);
      expect(back).toBe("a\nb\n\nc\n");
      // Idempotent — second round-trip must match.
      const pm2 = markdownToPmJson(back);
      expect(pmJsonToMarkdown(pm2)).toBe(back);
    });
  });

  it("round-trips a paragraph + HR + heading without re-promoting to Setext", () => {
    const md = "First paragraph.\n\n---\n\n## Heading\n\nBody.\n";
    const json = markdownToPmJson(md);
    const out = pmJsonToMarkdown(json);
    const json2 = markdownToPmJson(out);
    const types1 = (json.content as Array<{ type: string }>).map((n) => n.type);
    const types2 = (json2.content as Array<{ type: string }>).map(
      (n) => n.type,
    );
    expect(types2).toEqual(types1);
    expect(types1).toEqual([
      "paragraph",
      "horizontalRule",
      "heading",
      "paragraph",
    ]);
  });
});

describe("renderPmDocToMarkdown GFM", () => {
  it("emits HR with surrounding blank lines so re-parse stays HR (not Setext H2)", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Para text" }],
        },
        { type: "horizontalRule" },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Next" }],
        },
      ],
    };
    const out = renderPmDocToMarkdown(JSON.stringify(doc));
    // Must NOT be `Para text\n---\n## Next\n` — that round-trips into Setext H2.
    expect(out).toMatch(/Para text\n\n---\n\n## Next/);
  });

  it("emits blank lines between block-level children", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Para A" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Para B" }],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "H" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Para C" }],
        },
      ],
    };
    const out = renderPmDocToMarkdown(JSON.stringify(doc));
    expect(out).toBe("Para A\n\nPara B\n\n## H\n\nPara C\n");
  });

  it("emits `\\n` for hardBreak node (round-trips with breaks: true parser)", () => {
    const doc = {
      type: "doc",
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
    };
    const out = renderPmDocToMarkdown(JSON.stringify(doc));
    expect(out).toBe("a\nb\n");
  });

  it("survives double round-trip (paragraphs do NOT collapse into one)", () => {
    // Regression guard for the pre-fix bug where doc.join('') produced
    // `Para1\nPara2\n` (no blank line), causing the 2nd parse to collapse the
    // three paragraphs into a single soft-break-joined paragraph.
    const md = "Para one.\n\nPara two.\n\nPara three.\n";
    const pm1 = markdownToPmJson(md);
    const md1 = pmJsonToMarkdown(pm1);
    const pm2 = markdownToPmJson(md1);
    expect((pm2.content as Array<{ type: string }>).length).toBe(3);
    const md2 = pmJsonToMarkdown(pm2);
    expect(md2).toBe(md1);
  });

  it("serializes task items via renderList", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "done" }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(renderPmDocToMarkdown(JSON.stringify(doc))).toContain("- [x] done");
  });
});
