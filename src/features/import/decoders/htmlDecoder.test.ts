import { describe, expect, it } from "vitest";
import { htmlDecoder, stripHtmlToText } from "./htmlDecoder";

describe("HTML import decoder", () => {
  it("preserves headings, paragraphs, line breaks, and decoded entities", () => {
    const text = stripHtmlToText(
      "<h1>Title &amp; More</h1><p>Line one<br>Line two&nbsp;end</p>",
    );

    expect(text).toBe("Title & More\n\nLine one\nLine two end");
  });

  it("does not extract script or style content with whitespace in end tags", () => {
    const text = stripHtmlToText(
      [
        "<p>before</p>",
        "<script>script payload</script >",
        "<style>style payload</style\n>",
        "<p>after</p>",
      ].join(""),
    );

    expect(text).toBe("before\n\nafter");
    expect(text).not.toContain("payload");
  });

  it("decodes character references exactly once", () => {
    expect(
      stripHtmlToText(
        "<p>&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;</p>",
      ),
    ).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("builds one import block per extracted paragraph", () => {
    const result = htmlDecoder.decode({
      resourceKey: "chapter",
      relativePath: "chapter.html",
      bytes: new TextEncoder().encode("<p>First</p><p>Second<br>line</p>"),
    });

    expect(result.blocks).toEqual([
      {
        blockId: "chapter:html-p0",
        kind: "paragraph",
        text: "First",
        locator: {
          resourceKey: "chapter",
          relativePath: "chapter.html",
        },
      },
      {
        blockId: "chapter:html-p1",
        kind: "paragraph",
        text: "Second\nline",
        locator: {
          resourceKey: "chapter",
          relativePath: "chapter.html",
        },
      },
    ]);
  });
});
