// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { CodexSemanticLinkMark } from "./CodexSemanticLinkMark";

function makeEditor(content: string | Record<string, unknown>) {
  return new Editor({
    extensions: [StarterKit, CodexSemanticLinkMark],
    content,
  });
}

describe("CodexSemanticLinkMark", () => {
  it("stores a stable Codex id and fallback label on the selected span", () => {
    const editor = makeEditor("<p>銀の魔女が笑った。</p>");
    try {
      editor
        .chain()
        .setTextSelection({ from: 1, to: 5 })
        .setMark("codexSemanticLink", {
          entryId: "entry-elara",
          label: "エララ",
        })
        .run();

      const firstText = editor.getJSON().content?.[0]?.content?.[0];
      expect(firstText).toMatchObject({
        type: "text",
        text: "銀の魔女",
        marks: [
          {
            type: "codexSemanticLink",
            attrs: { entryId: "entry-elara", label: "エララ" },
          },
        ],
      });
    } finally {
      editor.destroy();
    }
  });

  it("does not extend the link when typing at its trailing boundary", () => {
    const editor = makeEditor("<p>alias</p>");
    try {
      editor
        .chain()
        .setTextSelection({ from: 1, to: 6 })
        .setMark("codexSemanticLink", { entryId: "entry-1", label: "Alice" })
        .setTextSelection(6)
        .insertContent("!")
        .run();

      const content = editor.getJSON().content?.[0]?.content ?? [];
      expect(content[0]).toMatchObject({
        text: "alias",
        marks: [
          {
            type: "codexSemanticLink",
            attrs: { entryId: "entry-1", label: "Alice" },
          },
        ],
      });
      expect(content.at(-1)).toMatchObject({ text: "!" });
      expect(content.at(-1)?.marks).toBeUndefined();
    } finally {
      editor.destroy();
    }
  });

  it("does not carry the semantic link into a paragraph split", () => {
    const editor = makeEditor("<p>alias</p>");
    try {
      editor
        .chain()
        .setTextSelection({ from: 1, to: 6 })
        .setMark("codexSemanticLink", {
          entryId: "entry-1",
          label: "Alice",
        })
        .setTextSelection(3)
        .splitBlock()
        .insertContent("next")
        .run();

      const secondParagraph = editor.getJSON().content?.[1];
      expect(secondParagraph?.content?.[0]).toMatchObject({ text: "next" });
      expect(secondParagraph?.content?.[0]?.marks).toBeUndefined();
    } finally {
      editor.destroy();
    }
  });

  it("survives generic clear-formatting commands", () => {
    const editor = makeEditor("<p>alias</p>");
    try {
      editor
        .chain()
        .setTextSelection({ from: 1, to: 6 })
        .setMark("codexSemanticLink", {
          entryId: "entry-1",
          label: "Alice",
        })
        .setBold()
        .run();
      editor.chain().setTextSelection({ from: 1, to: 6 }).unsetAllMarks().run();

      expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toEqual([
        {
          type: "codexSemanticLink",
          attrs: { entryId: "entry-1", label: "Alice" },
        },
      ]);
    } finally {
      editor.destroy();
    }
  });

  it("round-trips through semantic-link HTML without losing its target", () => {
    const source = makeEditor("<p>the silver witch</p>");
    const restored = makeEditor("");
    try {
      source
        .chain()
        .setTextSelection({ from: 5, to: 17 })
        .setMark("codexSemanticLink", { entryId: "entry-7", label: "Elara" })
        .run();

      const html = source.getHTML();
      expect(html).toContain("data-codex-semantic-link");
      expect(html).toContain('data-codex-entry-id="entry-7"');
      expect(html).toContain("codex-semantic-link");

      restored.commands.setContent(html);
      expect(restored.getJSON()).toEqual(source.getJSON());
    } finally {
      source.destroy();
      restored.destroy();
    }
  });
});
