import { describe, it, expect } from "vitest";
import { extractMarksFromPmDoc } from "./marksExtractor";

describe("marksExtractor", () => {
  it("extracts authorship and comment marks with PM positions", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "hello",
              marks: [
                {
                  type: "authorship",
                  attrs: { source: "ai", model: "test/model" },
                },
              ],
            },
            {
              type: "text",
              text: " world",
              marks: [
                {
                  type: "comment",
                  attrs: { text: "note", createdAt: "2024-01-01T00:00:00Z" },
                },
              ],
            },
          ],
        },
      ],
    };

    const result = extractMarksFromPmDoc(JSON.stringify(doc));
    expect(result.schemaVersion).toBe(1);
    expect(result.marks).toHaveLength(2);
    expect(result.marks[0]).toMatchObject({
      type: "authorship",
      from: 2,
      to: 7,
      attrs: { source: "ai", model: "test/model" },
    });
    expect(result.marks[1]).toMatchObject({
      type: "comment",
      from: 7,
      to: 13,
    });
  });

  it("extracts annotation and lintDisable marks", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "x",
              marks: [
                {
                  type: "peAnnotation",
                  attrs: {
                    annotationId: "a1",
                    category: "consistency_anchor",
                    severity: "warning",
                    status: "open",
                  },
                },
                { type: "lintDisable", attrs: { rules: ["ja/foo"] } },
              ],
            },
          ],
        },
      ],
    };

    const result = extractMarksFromPmDoc(JSON.stringify(doc));
    expect(result.marks.map((m) => m.type)).toEqual([
      "annotation",
      "lintDisable",
    ]);
  });

  it("excludes foreshadow marks", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "hint",
              marks: [
                { type: "foreshadowSetup", attrs: { setupId: "s1" } },
                { type: "foreshadowPayoff", attrs: { foreshadowId: "f1" } },
              ],
            },
          ],
        },
      ],
    };

    const result = extractMarksFromPmDoc(JSON.stringify(doc));
    expect(result.marks).toHaveLength(0);
  });
});
