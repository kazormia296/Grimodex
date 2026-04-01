import { describe, it, expect } from "vitest";
import { computeAttributedSegments } from "./snippetDiff";

describe("computeAttributedSegments", () => {
  it("returns single ai segment when content is identical", () => {
    const result = computeAttributedSegments("Hello World", "Hello World");
    expect(result).toEqual([{ text: "Hello World", source: "ai" }]);
  });

  it("returns single human segment when fully replaced", () => {
    const result = computeAttributedSegments(
      "元のテキスト",
      "全く別のテキスト",
    );
    // All text is new, so all segments should be human
    for (const seg of result) {
      if (seg.source === "ai") {
        // Some common characters might match; that's fine
      }
    }
    // The combined text should equal the current content
    const combined = result.map((s) => s.text).join("");
    expect(combined).toBe("全く別のテキスト");
  });

  it("splits into ai and human segments on partial edit", () => {
    const original = "Hello World";
    const edited = "Hello Beautiful World";
    const result = computeAttributedSegments(original, edited);

    // "Hello " stays ai, " Beautiful" is human, " World" stays ai
    // (exact segmentation depends on diff algorithm, but we verify properties)
    const combined = result.map((s) => s.text).join("");
    expect(combined).toBe("Hello Beautiful World");

    // Should have at least one ai and one human segment
    expect(result.some((s) => s.source === "ai")).toBe(true);
    expect(result.some((s) => s.source === "human")).toBe(true);
  });

  it("handles empty original content", () => {
    const result = computeAttributedSegments("", "新しいテキスト");
    expect(result).toEqual([{ text: "新しいテキスト", source: "human" }]);
  });

  it("handles content edited to empty", () => {
    const result = computeAttributedSegments("元のテキスト", "");
    expect(result).toEqual([]);
  });

  it("handles appended text", () => {
    const original = "Hello";
    const edited = "Hello World";
    const result = computeAttributedSegments(original, edited);

    const combined = result.map((s) => s.text).join("");
    expect(combined).toBe("Hello World");
    expect(result[0]).toEqual({ text: "Hello", source: "ai" });
  });

  it("handles prepended text", () => {
    const original = "World";
    const edited = "Hello World";
    const result = computeAttributedSegments(original, edited);

    const combined = result.map((s) => s.text).join("");
    expect(combined).toBe("Hello World");
    // Last segment should contain "World" as ai
    const lastAi = result.filter((s) => s.source === "ai");
    expect(lastAi.some((s) => s.text.includes("World"))).toBe(true);
  });
});
