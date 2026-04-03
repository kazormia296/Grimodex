import { describe, it, expect } from "vitest";
import { extractPlainText } from "./prosemirrorTextExtractor";

describe("extractPlainText", () => {
  it("returns empty string for empty input", () => {
    expect(extractPlainText("")).toBe("");
  });

  it("returns empty string for invalid JSON", () => {
    expect(extractPlainText("not-json")).toBe("");
    expect(extractPlainText("{unclosed")).toBe("");
  });

  it("extracts text from a simple text node", () => {
    const doc = JSON.stringify({ type: "text", text: "Hello" });
    expect(extractPlainText(doc)).toBe("Hello");
  });

  it("extracts text from a simple paragraph", () => {
    const doc = JSON.stringify({
      type: "paragraph",
      content: [{ type: "text", text: "Hello World" }],
    });
    expect(extractPlainText(doc)).toBe("Hello World");
  });

  it("extracts text from nested doc > paragraph > text", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Nested text" }],
        },
      ],
    });
    expect(extractPlainText(doc)).toBe("Nested text");
  });

  it("extracts text from multiple paragraphs", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: "World" },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Second paragraph" }],
        },
      ],
    });
    const result = extractPlainText(doc);
    expect(result).toContain("Hello");
    expect(result).toContain("Second paragraph");
  });

  it("skips nodes with no text (e.g. hardBreak)", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Before" },
            { type: "hardBreak" },
            { type: "text", text: "After" },
          ],
        },
      ],
    });
    const result = extractPlainText(doc);
    expect(result).toContain("Before");
    expect(result).toContain("After");
    // hardBreak has no text so it's simply skipped
    expect(result).not.toContain("hardBreak");
  });

  it("collapses multiple whitespace into single space", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "a" }] },
        { type: "paragraph", content: [{ type: "text", text: "b" }] },
      ],
    });
    const result = extractPlainText(doc);
    expect(result).toMatch(/^a b$/);
  });
});
