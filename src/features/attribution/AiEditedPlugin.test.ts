import { describe, it, expect, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "./AuthorshipMark";
import {
  createAiEditedPlugin,
  EDIT_RATIO_THRESHOLD,
  EDIT_ABS_THRESHOLD,
} from "./AiEditedPlugin";

function createTestEditor(content = "") {
  const editor = new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content,
  });
  editor.registerPlugin(createAiEditedPlugin());
  return editor;
}

function insertAiText(editor: Editor, text: string) {
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setMeta("programmaticInsert", true);
      return true;
    })
    .insertContent([
      {
        type: "text",
        text,
        marks: [
          {
            type: "authorship",
            attrs: {
              source: "ai",
              chatMessageId: "msg-1",
              timestamp: "2026-03-31T00:00:00.000Z",
            },
          },
        ],
      },
    ])
    .run();
}

function findAuthorshipSources(editor: Editor): string[] {
  const sources: string[] = [];
  editor.state.doc.descendants((node) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "authorship");
    if (mark) sources.push(mark.attrs.source as string);
  });
  return sources;
}

describe("AiEditedPlugin", () => {
  let editor: Editor;

  beforeEach(() => {
    editor = createTestEditor("<p>テスト文章</p>");
  });

  it("does not reclassify on programmatic insert", () => {
    insertAiText(editor, "AI生成テキスト");

    const sources = findAuthorshipSources(editor);
    expect(sources).toContain("ai");
    expect(sources).not.toContain("mixed");
    editor.destroy();
  });

  it("reclassifies ai to mixed when user types into ai text", () => {
    insertAiText(editor, "AI文章");

    // Find the position of the AI text and type into it
    let aiPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "AI文章") {
        aiPos = pos;
      }
    });
    expect(aiPos).toBeGreaterThan(0);

    // Simulate user typing (no programmaticInsert meta)
    editor
      .chain()
      .focus()
      .insertContentAt(aiPos + 1, "追加")
      .run();

    const sources = findAuthorshipSources(editor);
    expect(sources).toContain("mixed");
    editor.destroy();
  });

  it("does not reclassify human text", () => {
    // Type some normal text (no authorship mark → unmarked)
    editor.chain().focus().insertContent("人間テキスト").run();

    const sources = findAuthorshipSources(editor);
    expect(sources).not.toContain("mixed");
    editor.destroy();
  });

  it("does not reclassify snippet text", () => {
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setMeta("programmaticInsert", true);
        return true;
      })
      .insertContent([
        {
          type: "text",
          text: "スニペット",
          marks: [
            {
              type: "authorship",
              attrs: { source: "snippet" },
            },
          ],
        },
      ])
      .run();

    // Edit within snippet range
    let snippetPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "スニペット") {
        snippetPos = pos;
      }
    });

    if (snippetPos > 0) {
      editor
        .chain()
        .focus()
        .insertContentAt(snippetPos + 1, "X")
        .run();
    }

    const sources = findAuthorshipSources(editor);
    // snippet should remain snippet, not become mixed
    expect(sources).not.toContain("mixed");
    editor.destroy();
  });

  it("does not reclassify ai text with manualOverride", () => {
    // Insert AI text with manualOverride: true
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setMeta("programmaticInsert", true);
        return true;
      })
      .insertContent([
        {
          type: "text",
          text: "手動AI",
          marks: [
            {
              type: "authorship",
              attrs: {
                source: "ai",
                chatMessageId: "msg-manual",
                timestamp: "2026-03-31T00:00:00.000Z",
                manualOverride: true,
              },
            },
          ],
        },
      ])
      .run();

    // Find position and edit
    let aiPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "手動AI") {
        aiPos = pos;
      }
    });
    expect(aiPos).toBeGreaterThan(0);

    editor
      .chain()
      .focus()
      .insertContentAt(aiPos + 1, "追加")
      .run();

    // Should still be "ai", not "mixed", because manualOverride is true
    const sources = findAuthorshipSources(editor);
    expect(sources).not.toContain("mixed");
    expect(sources).toContain("ai");
    editor.destroy();
  });

  it("exports threshold constants", () => {
    expect(EDIT_RATIO_THRESHOLD).toBe(0.1);
    expect(EDIT_ABS_THRESHOLD).toBe(5);
  });

  it("keeps ai for minor edits below threshold", () => {
    // Insert a long AI text (50 chars) so a 1-char edit is well below 10%
    const longText =
      "これは長いAI生成テキストです。テスト用の文章を書いています。あいうえお";
    insertAiText(editor, longText);

    let aiPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === longText) {
        aiPos = pos;
      }
    });
    expect(aiPos).toBeGreaterThan(0);

    // Insert 1 character — below both thresholds (< 10% ratio, < 5 abs chars)
    editor
      .chain()
      .focus()
      .insertContentAt(aiPos + 1, "X")
      .run();

    const sources = findAuthorshipSources(editor);
    expect(sources).toContain("ai");
    expect(sources).not.toContain("mixed");
    editor.destroy();
  });

  it("transitions to mixed for large edits above threshold", () => {
    // Insert a short AI text (5 chars)
    insertAiText(editor, "短い文章だ");

    let aiPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "短い文章だ") {
        aiPos = pos;
      }
    });
    expect(aiPos).toBeGreaterThan(0);

    // Insert 6 characters — exceeds both thresholds (> 5 abs, > 10% ratio)
    editor
      .chain()
      .focus()
      .insertContentAt(aiPos + 1, "大幅な変更です")
      .run();

    const sources = findAuthorshipSources(editor);
    expect(sources).toContain("mixed");
    editor.destroy();
  });
});
