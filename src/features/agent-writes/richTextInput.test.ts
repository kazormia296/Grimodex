import { describe, expect, it } from "vitest";
import {
  agentMarkdownToProseMirrorJson,
  MAX_AGENT_RICH_TEXT_BYTES,
  validateAgentProseMirrorJson,
} from "./richTextInput";

describe("Agent rich-text input", () => {
  it("converts Markdown to a canonical editor document", () => {
    const value = JSON.parse(
      agentMarkdownToProseMirrorJson("# Heading\n\nBody"),
    ) as Record<string, unknown>;
    expect(value.type).toBe("doc");
    expect(value.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "heading" }),
        expect.objectContaining({ type: "paragraph" }),
      ]),
    );
  });

  it.each(["null", "[]", '{"type":"paragraph"}'])(
    "rejects an invalid root: %s",
    (input) => {
      expect(() => validateAgentProseMirrorJson(input)).toThrow();
    },
  );

  it("rejects unknown nodes and marks", () => {
    expect(() =>
      validateAgentProseMirrorJson(
        JSON.stringify({
          type: "doc",
          content: [{ type: "unknown-node" }],
        }),
      ),
    ).toThrow(/editor schema/);
    expect(() =>
      validateAgentProseMirrorJson(
        JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "x",
                  marks: [{ type: "unknown-mark" }],
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/editor schema/);
  });

  it("rejects structurally invalid content even when every node type exists", () => {
    expect(() =>
      validateAgentProseMirrorJson(
        JSON.stringify({
          type: "doc",
          content: [{ type: "text", text: "not a top-level block" }],
        }),
      ),
    ).toThrow(/editor schema/);
  });

  it("rejects oversized Markdown before conversion", () => {
    expect(() =>
      agentMarkdownToProseMirrorJson("x".repeat(MAX_AGENT_RICH_TEXT_BYTES + 1)),
    ).toThrow(/exceeds/);
  });
});
