import { describe, expect, it } from "vitest";
import { prosemirrorToText, tiptapContentFromDb } from "./prosemirror";

describe("tiptapContentFromDb", () => {
  it("parses ProseMirror JSON string into object for TipTap", () => {
    const raw = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    });
    const out = tiptapContentFromDb(raw);
    expect(out).toEqual(JSON.parse(raw));
  });

  it("returns empty for empty or {}", () => {
    expect(tiptapContentFromDb("")).toBe("");
    expect(tiptapContentFromDb("{}")).toBe("");
  });

  it("passes through non-JSON (e.g. HTML) unchanged", () => {
    const html = "<p>x</p>";
    expect(tiptapContentFromDb(html)).toBe(html);
  });
});

describe("prosemirrorToText", () => {
  it("extracts text from ProseMirror JSON string", () => {
    const raw = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "a" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "b" }],
        },
      ],
    });
    expect(prosemirrorToText(raw).trim()).toBe("a\nb");
  });
});
