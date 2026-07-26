import { describe, expect, it } from "vitest";
import {
  extractCodexSemanticLinks,
  getCodexSemanticLinkEntryIds,
} from "./semanticLinks";

const DOCUMENT = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "銀の",
          marks: [
            {
              type: "codexSemanticLink",
              attrs: { entryId: "entry-1", label: "エララ" },
            },
          ],
        },
        {
          type: "text",
          text: "魔女",
          marks: [
            { type: "bold" },
            {
              type: "codexSemanticLink",
              attrs: { entryId: "entry-1", label: "エララ" },
            },
          ],
        },
        { type: "text", text: "と" },
        {
          type: "text",
          text: "鎖",
          marks: [
            {
              type: "codexSemanticLink",
              attrs: { entryId: "entry-2", label: "束縛" },
            },
          ],
        },
      ],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "彼女",
          marks: [
            {
              type: "codexSemanticLink",
              attrs: { entryId: "entry-1", label: "エララ" },
            },
          ],
        },
      ],
    },
  ],
};

describe("extractCodexSemanticLinks", () => {
  it("coalesces adjacent text runs split by other marks, but not block boundaries", () => {
    expect(extractCodexSemanticLinks(DOCUMENT)).toEqual([
      { entryId: "entry-1", label: "エララ", text: "銀の魔女" },
      { entryId: "entry-2", label: "束縛", text: "鎖" },
      { entryId: "entry-1", label: "エララ", text: "彼女" },
    ]);
  });

  it("accepts serialized ProseMirror JSON and returns stable unique entry ids", () => {
    expect(getCodexSemanticLinkEntryIds(JSON.stringify(DOCUMENT))).toEqual([
      "entry-1",
      "entry-2",
    ]);
  });

  it("ignores invalid ids, blank spans, malformed JSON, and unknown input", () => {
    const invalid = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "ignored",
              marks: [{ type: "codexSemanticLink", attrs: { entryId: "  " } }],
            },
            {
              type: "text",
              text: "   ",
              marks: [
                {
                  type: "codexSemanticLink",
                  attrs: { entryId: "entry-1" },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(extractCodexSemanticLinks(invalid)).toEqual([]);
    expect(extractCodexSemanticLinks("{bad json")).toEqual([]);
    expect(extractCodexSemanticLinks(null)).toEqual([]);
  });
});
