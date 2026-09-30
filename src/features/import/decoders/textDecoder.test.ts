import { describe, expect, it } from "vitest";
import { textDecoder, splitParagraphs } from "./textDecoder";

describe("textDecoder", () => {
  it("splits paragraphs on blank lines", () => {
    expect(splitParagraphs("A\n\nB\n\nC")).toEqual(["A", "B", "C"]);
  });

  it("decodes plain text into paragraph blocks", () => {
    const bytes = new TextEncoder().encode("Line one.\n\nLine two.");
    const decoded = textDecoder.decode({
      resourceKey: "r1",
      relativePath: "chapter.txt",
      bytes,
    });
    expect(decoded.kind).toBe("text");
    expect(decoded.blocks).toHaveLength(2);
    expect(decoded.blocks[0]?.text).toBe("Line one.");
  });
});
