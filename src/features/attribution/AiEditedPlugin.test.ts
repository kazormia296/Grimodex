import { describe, it, expect, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "./AuthorshipMark";
import { createAiEditedPlugin } from "./AiEditedPlugin";

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
    expect(sources).not.toContain("ai-edited");
    editor.destroy();
  });

  it("reclassifies ai to ai-edited when user types into ai text", () => {
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
    editor.chain().focus().insertContentAt(aiPos + 1, "追加").run();

    const sources = findAuthorshipSources(editor);
    expect(sources).toContain("ai-edited");
    editor.destroy();
  });

  it("does not reclassify human text", () => {
    // Type some normal text (no authorship mark → unmarked)
    editor.chain().focus().insertContent("人間テキスト").run();

    const sources = findAuthorshipSources(editor);
    expect(sources).not.toContain("ai-edited");
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
      editor.chain().focus().insertContentAt(snippetPos + 1, "X").run();
    }

    const sources = findAuthorshipSources(editor);
    // snippet should remain snippet, not become ai-edited
    expect(sources).not.toContain("ai-edited");
    editor.destroy();
  });
});
