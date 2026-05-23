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
});

describe("renderPmDocToMarkdown GFM", () => {
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
