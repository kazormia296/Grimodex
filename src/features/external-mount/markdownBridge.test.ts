// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { renderPmDocToMarkdown } from "@/features/export/exportEngine";
import { pmJsonToMarkdown, markdownToPmJson } from "./markdownBridge";
import { useSettingsStore } from "@/features/settings/settingsStore";

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

    it("does not insert a blank line inside a multi-line raw HTML block (`<div>` on its own line)", () => {
      // Bug #3: html:true モードの HTML block (`<div>...</div>`) 内に `---`
      // 単独行があると、normalizer が直前に blank line を挿入して
      // CommonMark rule 7 で HTML block を終端させ、`---` が HR、続き部分が
      // 浮遊する paragraph + 閉じタグ単独行に分解されていた。HTML タグが
      // 開いている間は rescue を skip し、block を保つ。
      // TipTap schema は `<div>` ノードを持たないので最終的に1 paragraph に
      // 集約される ("A --- B")。重要なのは HR が現れない (= 分裂しない) こと。
      const md = "<div>\nA\n---\nB\n</div>\n";
      const doc = markdownToPmJson(md);
      const types = (doc.content as Array<{ type: string }>).map((n) => n.type);
      expect(types).toEqual(["paragraph"]);
    });

    it('does not insert a blank line for `<div class="x">` (open tag with attributes on its own line)', () => {
      const md = '<div class="note">\nA\n---\nB\n</div>\n';
      const doc = markdownToPmJson(md);
      const types = (doc.content as Array<{ type: string }>).map((n) => n.type);
      expect(types).toEqual(["paragraph"]);
    });

    it("does not insert a blank line for `<div>text...` (open tag with same-line content)", () => {
      // advisor-caught variant: end-anchored open-tag regex would miss this,
      // letting rescue fire inside the still-open HTML block. The permissive
      // regex catches it.
      const md = "<div>text\nA\n---\nB\n</div>\n";
      const doc = markdownToPmJson(md);
      const types = (doc.content as Array<{ type: string }>).map((n) => n.type);
      expect(types).toEqual(["paragraph"]);
    });

    it("still rescues `paragraph\\n---` when only an inline (single-line) HTML tag precedes it", () => {
      // 1 行で開閉する HTML タグは block を開かない (CommonMark の HTML
      // block 終了は空行 / 閉じタグ単独行)。直後の `paragraph\n---` は通常
      // 通り rescue 対象。
      const md = "<span>x</span>\nA\n---\nB\n";
      const doc = markdownToPmJson(md);
      const types = (doc.content as Array<{ type: string }>).map((n) => n.type);
      expect(types).toContain("horizontalRule");
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

  describe("editor.markdownStrictLineBreaks = true (CommonMark spec opt-in)", () => {
    // Mutate the cache directly to avoid the debounced persist side-effects
    // (the public `set()` triggers async workspace/DB writes that can outlive
    // the happy-dom environment in test teardown).
    function setStrict(value: "true" | "false"): void {
      useSettingsStore.setState((s) => ({
        cache: { ...s.cache, "editor.markdownStrictLineBreaks": value },
      }));
    }
    afterEach(() => setStrict("false"));

    it("falls back to soft break (space) when setting is enabled", () => {
      setStrict("true");
      const doc = markdownToPmJson("a\nb\n");
      const first = (doc.content as Array<Record<string, unknown>>)[0]!;
      const inner = first.content as Array<Record<string, unknown>>;
      // Single text node with space-joined content, no hardBreak.
      expect(inner).toHaveLength(1);
      expect(inner[0]?.type).toBe("text");
      expect(inner[0]?.text).toBe("a b");
    });

    it("toggling off restores hardBreak behaviour on the next parse", () => {
      setStrict("true");
      const strict = markdownToPmJson("a\nb\n");
      const strictInner = (
        (strict.content as Array<Record<string, unknown>>)[0]!.content as Array<
          Record<string, unknown>
        >
      ).map((n) => n.type);
      expect(strictInner).toEqual(["text"]);

      setStrict("false");
      const lax = markdownToPmJson("a\nb\n");
      const laxInner = (
        (lax.content as Array<Record<string, unknown>>)[0]!.content as Array<
          Record<string, unknown>
        >
      ).map((n) => n.type);
      expect(laxInner).toEqual(["text", "hardBreak", "text"]);
    });

    // CommonMark hardBreak markers (`  \n` or `\\\n`) survive strict mode —
    // they're spec-defined and independent of the `breaks` option. Without
    // this guarantee the round-trip fix below is meaningless.
    it("parses `  \\n` (two trailing spaces) as hardBreak even with strict on", () => {
      setStrict("true");
      const doc = markdownToPmJson("a  \nb\n");
      const inner = (
        (doc.content as Array<Record<string, unknown>>)[0]!.content as Array<
          Record<string, unknown>
        >
      ).map((n) => n.type);
      expect(inner).toEqual(["text", "hardBreak", "text"]);
    });

    // Regression guard for the data-loss bug: with strict mode on, the
    // exporter previously emitted a bare `\n` for hardBreak, which the
    // strict-mode parser then collapsed into a soft break (space) on the
    // next read — silently dropping the hardBreak forever.
    it("round-trip preserves hardBreak under strict mode (`a  \\nb` survives)", () => {
      setStrict("true");
      const md = "a  \nb\n";
      const pm = markdownToPmJson(md);
      const back = pmJsonToMarkdown(pm);
      // Re-parse must still yield a hardBreak (not a soft-break-collapsed text).
      const pm2 = markdownToPmJson(back);
      const inner = (
        (pm2.content as Array<Record<string, unknown>>)[0]!.content as Array<
          Record<string, unknown>
        >
      ).map((n) => n.type);
      expect(inner).toEqual(["text", "hardBreak", "text"]);
      // Idempotent: second round-trip equals the first.
      expect(pmJsonToMarkdown(pm2)).toBe(back);
    });
  });

  describe("nested block structure preservation", () => {
    function nodeTypes(doc: Record<string, unknown>): string[] {
      return (doc.content as Array<Record<string, unknown>>).map(
        (n) => n.type as string,
      );
    }

    it("loose list with multi-paragraph item round-trips paragraph structure", () => {
      const md = "- first\n\n  second\n\n- next item\n";
      const pm = markdownToPmJson(md);
      const back = pmJsonToMarkdown(pm);
      const pm2 = markdownToPmJson(back);
      // Item 1 must still hold two paragraphs after round-trip.
      const list = (pm2.content as Array<Record<string, unknown>>)[0]!;
      const items = list.content as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      const item1Children = (items[0]!.content as Array<{ type: string }>).map(
        (n) => n.type,
      );
      expect(item1Children).toEqual(["paragraph", "paragraph"]);
    });

    it("multi-paragraph blockquote preserves both paragraphs", () => {
      const md = "> first\n>\n> second\n";
      const pm = markdownToPmJson(md);
      const back = pmJsonToMarkdown(pm);
      const pm2 = markdownToPmJson(back);
      const bq = (pm2.content as Array<Record<string, unknown>>)[0]!;
      expect(bq.type).toBe("blockquote");
      const inner = (bq.content as Array<{ type: string }>).map((n) => n.type);
      // Must be two paragraphs (not one paragraph with hardBreak / soft join).
      expect(inner).toEqual(["paragraph", "paragraph"]);
    });

    it("blockquote with nested loose list keeps the list inside the quote", () => {
      const md = "> outer\n>\n> - a\n>\n>   b\n";
      const pm = markdownToPmJson(md);
      const back = pmJsonToMarkdown(pm);
      const pm2 = markdownToPmJson(back);
      const top = nodeTypes(pm2);
      // Top level: just the blockquote — list & continuation must NOT escape.
      expect(top).toEqual(["blockquote"]);
      const bq = (pm2.content as Array<Record<string, unknown>>)[0]!;
      const bqInner = (bq.content as Array<{ type: string }>).map(
        (n) => n.type,
      );
      expect(bqInner).toEqual(["paragraph", "bulletList"]);
    });

    it("task item with multi-paragraph keeps continuation inside the item", () => {
      const md = "- [ ] one\n\n  two\n";
      const pm = markdownToPmJson(md);
      const back = pmJsonToMarkdown(pm);
      const pm2 = markdownToPmJson(back);
      const top = nodeTypes(pm2);
      // Continuation must NOT escape to a top-level paragraph.
      expect(top).toEqual(["taskList"]);
      const item = (
        (pm2.content as Array<Record<string, unknown>>)[0]!.content as Array<
          Record<string, unknown>
        >
      )[0]!;
      const itemChildren = (item.content as Array<{ type: string }>).map(
        (n) => n.type,
      );
      expect(itemChildren).toEqual(["paragraph", "paragraph"]);
    });

    it("tight list stays tight (no extra blank lines)", () => {
      const md = "- a\n- b\n- c\n";
      const pm = markdownToPmJson(md);
      const back = pmJsonToMarkdown(pm);
      // Must NOT introduce blank lines between items of a tight list.
      expect(back).toBe("- a\n- b\n- c\n");
    });
  });

  describe("consecutive blank lines preserved as empty paragraph nodes", () => {
    function nodeTypes(doc: Record<string, unknown>): string[] {
      return (doc.content as Array<Record<string, unknown>>).map(
        (n) => n.type as string,
      );
    }

    // Pre-fix bug: markdown-it (CommonMark) collapses 2+ blank lines into a
    // single paragraph break, so users who wrote `A\n\n\nB` to add visual
    // spacing saw the extra blank silently dropped on import. We rewrite
    // them as `<p></p>` HTML blocks so they survive as empty paragraph nodes.

    it("preserves a single extra blank line (2 blanks) as one empty paragraph", () => {
      const md = "Para A\n\n\nPara B\n";
      const doc = markdownToPmJson(md);
      const types = nodeTypes(doc);
      expect(types).toEqual(["paragraph", "paragraph", "paragraph"]);
      // Middle paragraph is empty.
      const middle = (doc.content as Array<Record<string, unknown>>)[1]!;
      expect(middle.content ?? []).toEqual([]);
    });

    it("preserves two extra blank lines (3 blanks) as two empty paragraphs", () => {
      const md = "Para A\n\n\n\nPara B\n";
      const doc = markdownToPmJson(md);
      const types = nodeTypes(doc);
      expect(types).toEqual([
        "paragraph",
        "paragraph",
        "paragraph",
        "paragraph",
      ]);
    });

    it("does not insert empty paragraphs for a single blank line", () => {
      const md = "Para A\n\nPara B\n";
      const doc = markdownToPmJson(md);
      const types = nodeTypes(doc);
      expect(types).toEqual(["paragraph", "paragraph"]);
    });

    it("does not expand blank lines inside fenced code blocks", () => {
      const md = "```\nfoo\n\n\nbar\n```\n";
      const doc = markdownToPmJson(md);
      const types = nodeTypes(doc);
      expect(types).toEqual(["codeBlock"]);
      // The code block keeps the raw blanks (markdown-it preserves them).
      const cb = (doc.content as Array<Record<string, unknown>>)[0]!;
      const text = (cb.content as Array<{ text: string }>)
        .map((n) => n.text)
        .join("");
      expect(text).toContain("foo\n\n\nbar");
    });

    it("does not expand blank lines inside a multi-line HTML block", () => {
      // Within an open `<div>...</div>` HTML block the first blank line
      // closes the block per CommonMark — anything before that close stays
      // as raw HTML, and we don't inject `<p></p>` inside it.
      const md = "<div>\nA\nB\n</div>\n\n\nC\n";
      const doc = markdownToPmJson(md);
      // Top level has at least the trailing `<p></p>` (for the 2-blank gap)
      // and the `C` paragraph. The HTML-block content collapses to a
      // paragraph node ("A B") because TipTap has no `<div>` node.
      const types = nodeTypes(doc);
      expect(types[types.length - 1]).toBe("paragraph"); // C
      // An extra empty paragraph from the 2-blank run between </div> and C
      // must appear before C.
      const cIdx = types.lastIndexOf("paragraph");
      expect(cIdx).toBeGreaterThan(0);
      const beforeC = (doc.content as Array<Record<string, unknown>>)[
        cIdx - 1
      ]!;
      expect(beforeC.type).toBe("paragraph");
      expect(beforeC.content ?? []).toEqual([]);
    });

    it("preserves blank-line structure across full round-trip", () => {
      const md = "A\n\n\nB\n";
      const pm = markdownToPmJson(md);
      const back = pmJsonToMarkdown(pm);
      // Round-trip must still parse to 3 paragraphs (A, empty, B).
      const pm2 = markdownToPmJson(back);
      const types = nodeTypes(pm2);
      expect(types).toEqual(["paragraph", "paragraph", "paragraph"]);
      // Idempotent: same markdown after a second round-trip.
      expect(pmJsonToMarkdown(pm2)).toBe(back);
    });

    it("preserves multiple blank-line runs in the same document", () => {
      const md = "A\n\n\nB\n\n\n\nC\n";
      const doc = markdownToPmJson(md);
      const types = nodeTypes(doc);
      // A, [empty], B, [empty], [empty], C
      expect(types).toEqual([
        "paragraph",
        "paragraph",
        "paragraph",
        "paragraph",
        "paragraph",
        "paragraph",
      ]);
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
