import { describe, it, expect, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "./AuthorshipMark";
import {
  createAiEditedPlugin,
  EDIT_RATIO_THRESHOLD,
  EDIT_ABS_THRESHOLD,
  HUMAN_RATIO_THRESHOLD,
  HUMAN_ABS_THRESHOLD,
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

function insertMixedText(editor: Editor, text: string) {
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
              source: "mixed",
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
    // "AI文章" is 4 chars, inserting "追加" (2 chars) gives totalChanged=2
    // editRatio = 2/4 = 0.5 >= 0.1, totalChanged = 2 < 5
    // With BOTH required: ratio OK but abs NOT → stays ai
    editor
      .chain()
      .focus()
      .insertContentAt(aiPos + 1, "追加")
      .run();

    // With BOTH thresholds required, 2 chars is below abs threshold of 5
    const sources = findAuthorshipSources(editor);
    expect(sources).toContain("ai");
    expect(sources).not.toContain("mixed");
    editor.destroy();
  });

  it("reclassifies ai to mixed when BOTH thresholds exceeded", () => {
    insertAiText(editor, "AI文章");

    let aiPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "AI文章") {
        aiPos = pos;
      }
    });
    expect(aiPos).toBeGreaterThan(0);

    // Insert 6 chars into 4-char span: ratio=6/4=1.5 (>=0.1), abs=6 (>=5)
    // BOTH thresholds exceeded → mixed
    editor
      .chain()
      .focus()
      .insertContentAt(aiPos + 1, "大幅な変更です")
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
    expect(HUMAN_RATIO_THRESHOLD).toBe(0.8);
    expect(HUMAN_ABS_THRESHOLD).toBe(10);
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

  it("keeps ai when only ratio threshold exceeded but abs below", () => {
    // Short AI text (4 chars), 1 char edit = 25% ratio but only 1 abs char
    insertAiText(editor, "短文です");

    let aiPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "短文です") {
        aiPos = pos;
      }
    });
    expect(aiPos).toBeGreaterThan(0);

    // Insert 1 char: ratio = 1/4 = 25% (≥10%) but abs = 1 (<5)
    // BOTH required → stays ai
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

  it("keeps ai when only abs threshold exceeded but ratio below", () => {
    // Long AI text, 5 char edit = low ratio but abs ≥ 5
    const longText =
      "これはとても長いAI生成テキストです。百文字を超える長さのテキストを用意して、比率が低くなるようにしています。追加のパディングテキスト。";
    insertAiText(editor, longText);

    let aiPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === longText) {
        aiPos = pos;
      }
    });
    expect(aiPos).toBeGreaterThan(0);

    // Insert 5 chars: abs = 5 (≥5) but ratio = 5/68 ≈ 7.4% (<10%)
    // BOTH required → stays ai
    editor
      .chain()
      .focus()
      .insertContentAt(aiPos + 1, "ABCDE")
      .run();

    const sources = findAuthorshipSources(editor);
    expect(sources).toContain("ai");
    expect(sources).not.toContain("mixed");
    editor.destroy();
  });

  describe("mixed → human transition", () => {
    it("keeps mixed for minor edits", () => {
      insertMixedText(editor, "混合テキスト");

      let mixedPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "混合テキスト") {
          mixedPos = pos;
        }
      });
      expect(mixedPos).toBeGreaterThan(0);

      // Insert 1 char — well below both human thresholds
      editor
        .chain()
        .focus()
        .insertContentAt(mixedPos + 1, "X")
        .run();

      const sources = findAuthorshipSources(editor);
      expect(sources).toContain("mixed");
      expect(sources).not.toContain("human");
      editor.destroy();
    });

    it("transitions mixed to human when both thresholds exceeded", () => {
      // Short mixed text (10 chars)
      insertMixedText(editor, "混合テキストです。ab");

      let mixedPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "混合テキストです。ab") {
          mixedPos = pos;
        }
      });
      expect(mixedPos).toBeGreaterThan(0);

      // Insert 10 chars: ratio = 10/10 = 100% (≥80%), abs = 10 (≥10)
      // BOTH thresholds exceeded → human
      editor
        .chain()
        .focus()
        .insertContentAt(mixedPos + 1, "ABCDEFGHIJ")
        .run();

      const sources = findAuthorshipSources(editor);
      expect(sources).toContain("human");
      editor.destroy();
    });

    it("keeps mixed when only ratio threshold exceeded but abs below", () => {
      // Very short mixed text (5 chars)
      insertMixedText(editor, "混合です。");

      let mixedPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "混合です。") {
          mixedPos = pos;
        }
      });
      expect(mixedPos).toBeGreaterThan(0);

      // Insert 5 chars: ratio = 5/5 = 100% (≥80%) but abs = 5 (<10)
      // BOTH required → stays mixed
      editor
        .chain()
        .focus()
        .insertContentAt(mixedPos + 1, "ABCDE")
        .run();

      const sources = findAuthorshipSources(editor);
      expect(sources).toContain("mixed");
      expect(sources).not.toContain("human");
      editor.destroy();
    });

    it("does not reclassify mixed text with manualOverride", () => {
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
            text: "手動mixed",
            marks: [
              {
                type: "authorship",
                attrs: {
                  source: "mixed",
                  chatMessageId: "msg-manual",
                  timestamp: "2026-03-31T00:00:00.000Z",
                  manualOverride: true,
                },
              },
            ],
          },
        ])
        .run();

      let mixedPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "手動mixed") {
          mixedPos = pos;
        }
      });
      expect(mixedPos).toBeGreaterThan(0);

      // Large edit that would normally trigger human transition
      editor
        .chain()
        .focus()
        .insertContentAt(mixedPos + 1, "ABCDEFGHIJKLMN")
        .run();

      const sources = findAuthorshipSources(editor);
      expect(sources).toContain("mixed");
      expect(sources).not.toContain("human");
      editor.destroy();
    });
  });
});
