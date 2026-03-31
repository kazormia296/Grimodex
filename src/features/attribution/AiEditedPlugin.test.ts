import { describe, it, expect, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "./AuthorshipMark";
import { createAiEditedPlugin, HUMAN_LENGTH_RATIO } from "./AiEditedPlugin";

function createTestEditor(content = "") {
  const editor = new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content,
  });
  editor.registerPlugin(createAiEditedPlugin());
  return editor;
}

function insertAiText(editor: Editor, text: string, msgId = "msg-1") {
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
              chatMessageId: msgId,
              timestamp: new Date().toISOString(),
              originalLength: text.length,
              traceId: crypto.randomUUID(),
            },
          },
        ],
      },
    ])
    .run();
}

function insertMixedText(
  editor: Editor,
  text: string,
  originalLength: number,
  msgId = "msg-1",
) {
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
              chatMessageId: msgId,
              timestamp: new Date().toISOString(),
              originalLength,
              traceId: crypto.randomUUID(),
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

  it("exports HUMAN_LENGTH_RATIO constant", () => {
    expect(HUMAN_LENGTH_RATIO).toBe(0.2);
  });

  // --- ai → mixed: immediate on any edit ---

  it("does not reclassify on programmatic insert", () => {
    insertAiText(editor, "AI生成テキスト");
    const sources = findAuthorshipSources(editor);
    expect(sources).toContain("ai");
    expect(sources).not.toContain("mixed");
    editor.destroy();
  });

  it("splits ai node on 1 char insert (no ai→mixed transition)", () => {
    insertAiText(editor, "AI文章");

    let aiPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "AI文章") aiPos = pos;
    });
    expect(aiPos).toBeGreaterThan(0);

    // Insert 1 character — should split node, not transition to mixed
    editor.chain().focus().insertContentAt(aiPos + 1, "X").run();

    const sources = findAuthorshipSources(editor);
    // Flanking AI text stays "ai", inserted "X" has no authorship mark
    expect(sources).toContain("ai");
    expect(sources).not.toContain("mixed");
    editor.destroy();
  });

  it("reclassifies ai to mixed on 1 char delete", () => {
    const longText = "これは長いAI生成テキストです。";
    insertAiText(editor, longText);

    let aiPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === longText) aiPos = pos;
    });
    expect(aiPos).toBeGreaterThan(0);

    // Delete 1 character (set cursor first, like real user interaction)
    editor
      .chain()
      .focus()
      .setTextSelection(aiPos + 5)
      .deleteRange({ from: aiPos + 5, to: aiPos + 6 })
      .run();

    const sources = findAuthorshipSources(editor);
    expect(sources).toContain("mixed");
    expect(sources).not.toContain("ai");
    editor.destroy();
  });

  it("does not reclassify human text", () => {
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
          marks: [{ type: "authorship", attrs: { source: "snippet" } }],
        },
      ])
      .run();

    let snippetPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "スニペット") snippetPos = pos;
    });

    if (snippetPos > 0) {
      editor.chain().focus().insertContentAt(snippetPos + 1, "X").run();
    }

    const sources = findAuthorshipSources(editor);
    expect(sources).not.toContain("mixed");
    editor.destroy();
  });

  it("does not reclassify ai text with manualOverride", () => {
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
                manualOverride: true,
                originalLength: 4,
              },
            },
          ],
        },
      ])
      .run();

    let aiPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "手動AI") aiPos = pos;
    });
    expect(aiPos).toBeGreaterThan(0);

    editor.chain().focus().insertContentAt(aiPos + 1, "追加").run();

    const sources = findAuthorshipSources(editor);
    expect(sources).not.toContain("mixed");
    expect(sources).toContain("ai");
    editor.destroy();
  });

  // --- Adjacent node isolation ---

  it("editing one node does NOT affect adjacent nodes", () => {
    const text = "承知しました。「これは生成AIの生成した文章です。」";
    insertAiText(editor, text, "msg-1");
    insertAiText(editor, text, "msg-2");
    insertAiText(editor, text, "msg-3");

    // Find 2nd node and delete 1 char
    let count = 0;
    let secondNodePos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText) return;
      const mark = node.marks.find((m) => m.type.name === "authorship");
      if (mark?.attrs.source === "ai") {
        count++;
        if (count === 2) secondNodePos = pos;
      }
    });

    // Set cursor inside the 2nd node first (simulates real user interaction)
    editor
      .chain()
      .focus()
      .setTextSelection(secondNodePos + 5)
      .deleteRange({ from: secondNodePos + 5, to: secondNodePos + 6 })
      .run();

    const sources: { text: string; source: string }[] = [];
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      const mark = node.marks.find((m) => m.type.name === "authorship");
      if (mark)
        sources.push({
          text: (node.text ?? "").substring(0, 10),
          source: mark.attrs.source as string,
        });
    });

    // Only the 2nd node should become mixed
    expect(sources[0].source).toBe("ai");
    expect(sources[1].source).toBe("mixed");
    expect(sources[2].source).toBe("ai");
    editor.destroy();
  });

  it("inclusive:false prevents mark inheritance at insertion boundary", () => {
    // Simulate real insertFromChat: insertContentAt at cursor position after prior AI text
    const text = "承知しました。「これは生成AIの生成した文章です。」";
    for (let i = 0; i < 3; i++) {
      const { from } = editor.state.selection;
      const docEnd = editor.state.doc.content.size - 1;
      const insertPos = from > 0 ? from : Math.max(docEnd, 0);

      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setMeta("programmaticInsert", true);
          return true;
        })
        .insertContentAt(insertPos, [
          {
            type: "text",
            text,
            marks: [
              {
                type: "authorship",
                attrs: {
                  source: "ai",
                  chatMessageId: `msg-${i}`,
                  timestamp: new Date().toISOString(),
                  originalLength: text.length,
                  traceId: `trace-${i}`,
                },
              },
            ],
          },
        ])
        .run();
    }

    // Should have 3 separate text nodes (not merged)
    const nodes: { traceId: string; source: string }[] = [];
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      const mark = node.marks.find((m) => m.type.name === "authorship");
      if (mark) nodes.push({ traceId: mark.attrs.traceId, source: mark.attrs.source });
    });
    expect(nodes).toHaveLength(3);
    expect(nodes[0].traceId).toBe("trace-0");
    expect(nodes[1].traceId).toBe("trace-1");
    expect(nodes[2].traceId).toBe("trace-2");

    // Edit 2nd node — only it should become mixed
    let count = 0;
    let secondPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText) return;
      count++;
      if (count === 2) secondPos = pos;
    });
    editor
      .chain()
      .focus()
      .setTextSelection(secondPos + 2)
      .deleteRange({ from: secondPos + 2, to: secondPos + 3 })
      .run();

    const after: { source: string }[] = [];
    editor.state.doc.descendants((node) => {
      if (!node.isText) return;
      const mark = node.marks.find((m) => m.type.name === "authorship");
      if (mark) after.push({ source: mark.attrs.source });
    });
    expect(after[0].source).toBe("ai");
    expect(after[1].source).toBe("mixed");
    expect(after[2].source).toBe("ai");
    editor.destroy();
  });

  // --- mixed → human transition ---

  describe("mixed → human transition", () => {
    it("keeps mixed when remaining text > 20% of original", () => {
      // "ABCDEFGHIJKLMNOPQRST" = 20 chars
      const text = "ABCDEFGHIJKLMNOPQRST";
      insertMixedText(editor, text, text.length);

      let mixedPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === text) mixedPos = pos;
      });
      expect(mixedPos).toBeGreaterThan(0);

      // Delete 5 chars → remaining 15/20 = 75% > 20% → stays mixed
      editor
        .chain()
        .focus()
        .setTextSelection(mixedPos)
        .deleteRange({ from: mixedPos, to: mixedPos + 5 })
        .run();

      const sources = findAuthorshipSources(editor);
      expect(sources).toContain("mixed");
      expect(sources).not.toContain("human");
      editor.destroy();
    });

    it("transitions to human when remaining text ≤ 20% of original", () => {
      // "ABCDEFGHIJKLMNOPQRST" = 20 chars
      const text = "ABCDEFGHIJKLMNOPQRST";
      insertMixedText(editor, text, text.length);

      let mixedPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === text) mixedPos = pos;
      });
      expect(mixedPos).toBeGreaterThan(0);

      // Delete 17 chars → remaining 3/20 = 15% ≤ 20% → human
      editor
        .chain()
        .focus()
        .setTextSelection(mixedPos)
        .deleteRange({ from: mixedPos, to: mixedPos + 17 })
        .run();

      const sources = findAuthorshipSources(editor);
      expect(sources).toContain("human");
      expect(sources).not.toContain("mixed");
      editor.destroy();
    });

    it("transitions to human through incremental edits", () => {
      // 10 chars original
      insertMixedText(editor, "ABCDEFGHIJ", 10);

      // Delete 4 chars → remaining 6/10 = 60% > 20% → stays mixed
      let pos = -1;
      editor.state.doc.descendants((node, p) => {
        if (node.isText && node.marks.some((m) => m.attrs.source === "mixed"))
          pos = p;
      });
      editor
        .chain()
        .focus()
        .setTextSelection(pos)
        .deleteRange({ from: pos, to: pos + 4 })
        .run();

      let sources = findAuthorshipSources(editor);
      expect(sources).toContain("mixed");

      // Delete 4 more chars → remaining 2/10 = 20% ≤ 20% → human
      pos = -1;
      editor.state.doc.descendants((node, p) => {
        if (node.isText && node.marks.some((m) => m.attrs.source === "mixed"))
          pos = p;
      });
      editor
        .chain()
        .focus()
        .setTextSelection(pos)
        .deleteRange({ from: pos, to: pos + 4 })
        .run();

      sources = findAuthorshipSources(editor);
      expect(sources).toContain("human");
      expect(sources).not.toContain("mixed");
      editor.destroy();
    });

    it("does not transition mixed→human on pure insertion (node splitting)", () => {
      // Mixed text "ABCDEFGHIJKLMNOPQRST" (20 chars, originalLength=20)
      // Insert 80 chars → total 100, but originalLength still 20
      // Each flanking mixed node is shorter than original, but this is a split, not deletion
      const text = "ABCDEFGHIJKLMNOPQRST";
      insertMixedText(editor, text, text.length);

      let mixedPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === text) mixedPos = pos;
      });
      expect(mixedPos).toBeGreaterThan(0);

      // Insert text in the middle — should split, not trigger mixed→human
      editor
        .chain()
        .focus()
        .setTextSelection(mixedPos + 10)
        .insertContentAt(mixedPos + 10, "X".repeat(80))
        .run();

      const nodes: { text: string; source: string | null }[] = [];
      editor.state.doc.descendants((node) => {
        if (!node.isText) return;
        const mark = node.marks.find((m) => m.type.name === "authorship");
        nodes.push({ text: node.text ?? "", source: mark ? (mark.attrs.source as string) : null });
      });

      // Flanking nodes should still be mixed (not human)
      const mixedNodes = nodes.filter((n) => n.source === "mixed");
      expect(mixedNodes.length).toBeGreaterThanOrEqual(2);
      // Inserted text should have no authorship mark
      const unmarkedNodes = nodes.filter((n) => n.source === null);
      expect(unmarkedNodes.some((n) => n.text.includes("XXXX"))).toBe(true);
      editor.destroy();
    });

    it("does not transition mixed with manualOverride", () => {
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
            text: "手動mixed12345",
            marks: [
              {
                type: "authorship",
                attrs: {
                  source: "mixed",
                  manualOverride: true,
                  originalLength: 10,
                },
              },
            ],
          },
        ])
        .run();

      let mixedPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "手動mixed12345") mixedPos = pos;
      });
      expect(mixedPos).toBeGreaterThan(0);

      // Delete most of it
      editor
        .chain()
        .focus()
        .setTextSelection(mixedPos)
        .deleteRange({ from: mixedPos, to: mixedPos + 9 })
        .run();

      const sources = findAuthorshipSources(editor);
      expect(sources).toContain("mixed");
      expect(sources).not.toContain("human");
      editor.destroy();
    });
  });

  // --- Node splitting on insertion ---

  describe("node splitting on insertion within AI span", () => {
    it("splits AI span into three parts on pure insertion", () => {
      insertAiText(editor, "HelloWorld");

      let aiPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "HelloWorld") aiPos = pos;
      });
      expect(aiPos).toBeGreaterThan(0);

      // Insert "XYZ" between "Hello" and "World"
      editor
        .chain()
        .focus()
        .setTextSelection(aiPos + 5)
        .insertContentAt(aiPos + 5, "XYZ")
        .run();

      const nodes: { text: string; source: string | null }[] = [];
      editor.state.doc.descendants((node) => {
        if (!node.isText) return;
        const mark = node.marks.find((m) => m.type.name === "authorship");
        nodes.push({
          text: node.text ?? "",
          source: mark ? (mark.attrs.source as string) : null,
        });
      });

      // Should have: "テスト文章"(no mark) + "Hello"(ai) + "XYZ"(no mark) + "World"(ai)
      // Filter out the initial "テスト文章" node
      const relevantNodes = nodes.filter(
        (n) => n.text !== "テスト文章",
      );
      expect(relevantNodes).toHaveLength(3);
      expect(relevantNodes[0]).toEqual({ text: "Hello", source: "ai" });
      expect(relevantNodes[1]).toEqual({ text: "XYZ", source: null });
      expect(relevantNodes[2]).toEqual({ text: "World", source: "ai" });
      editor.destroy();
    });

    it("keeps AI mark on flanking text after insertion (no ai→mixed)", () => {
      insertAiText(editor, "ABCDE");

      let aiPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "ABCDE") aiPos = pos;
      });
      expect(aiPos).toBeGreaterThan(0);

      // Insert "X" between "AB" and "CDE"
      editor
        .chain()
        .focus()
        .setTextSelection(aiPos + 2)
        .insertContentAt(aiPos + 2, "X")
        .run();

      const sources = findAuthorshipSources(editor);
      expect(sources).toContain("ai");
      expect(sources).not.toContain("mixed");
      editor.destroy();
    });

    it("deletion still triggers ai→mixed (regression)", () => {
      insertAiText(editor, "ABCDE");

      let aiPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "ABCDE") aiPos = pos;
      });
      expect(aiPos).toBeGreaterThan(0);

      editor
        .chain()
        .focus()
        .setTextSelection(aiPos + 2)
        .deleteRange({ from: aiPos + 2, to: aiPos + 3 })
        .run();

      const sources = findAuthorshipSources(editor);
      expect(sources).toContain("mixed");
      expect(sources).not.toContain("ai");
      editor.destroy();
    });

    it("insertion inside mixed span splits without changing source", () => {
      insertMixedText(editor, "HelloWorld", 10);

      let mixedPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "HelloWorld") mixedPos = pos;
      });
      expect(mixedPos).toBeGreaterThan(0);

      editor
        .chain()
        .focus()
        .setTextSelection(mixedPos + 5)
        .insertContentAt(mixedPos + 5, "XYZ")
        .run();

      const nodes: { text: string; source: string | null }[] = [];
      editor.state.doc.descendants((node) => {
        if (!node.isText) return;
        const mark = node.marks.find((m) => m.type.name === "authorship");
        nodes.push({
          text: node.text ?? "",
          source: mark ? (mark.attrs.source as string) : null,
        });
      });

      const relevantNodes = nodes.filter(
        (n) => n.text !== "テスト文章",
      );
      expect(relevantNodes).toHaveLength(3);
      expect(relevantNodes[0]).toEqual({ text: "Hello", source: "mixed" });
      expect(relevantNodes[1]).toEqual({ text: "XYZ", source: null });
      expect(relevantNodes[2]).toEqual({ text: "World", source: "mixed" });
      editor.destroy();
    });

    it("does not split manualOverride span on insertion", () => {
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
            text: "ABCDE",
            marks: [
              {
                type: "authorship",
                attrs: {
                  source: "ai",
                  chatMessageId: "msg-mo",
                  manualOverride: true,
                  originalLength: 5,
                  traceId: crypto.randomUUID(),
                },
              },
            ],
          },
        ])
        .run();

      let aiPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "ABCDE") aiPos = pos;
      });
      expect(aiPos).toBeGreaterThan(0);

      editor
        .chain()
        .focus()
        .setTextSelection(aiPos + 2)
        .insertContentAt(aiPos + 2, "X")
        .run();

      // manualOverride node should not be split — inserted text inherits the mark
      const sources = findAuthorshipSources(editor);
      expect(sources).toContain("ai");
      // The "X" should also have the ai mark (not split out)
      let foundFullText = false;
      editor.state.doc.descendants((node) => {
        if (node.isText && node.text === "ABXCDE") foundFullText = true;
      });
      expect(foundFullText).toBe(true);
      editor.destroy();
    });

    it("does not split on programmatic insert within AI span", () => {
      insertAiText(editor, "ABCDE");

      let aiPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "ABCDE") aiPos = pos;
      });
      expect(aiPos).toBeGreaterThan(0);

      // Programmatic insert within the AI span
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setMeta("programmaticInsert", true);
          return true;
        })
        .insertContentAt(aiPos + 2, "X")
        .run();

      // Should not split — programmatic inserts are skipped
      const nodes: { text: string; source: string | null }[] = [];
      editor.state.doc.descendants((node) => {
        if (!node.isText) return;
        const mark = node.marks.find((m) => m.type.name === "authorship");
        nodes.push({
          text: node.text ?? "",
          source: mark ? (mark.attrs.source as string) : null,
        });
      });

      // The text should remain as one node (no splitting occurred)
      const aiNodes = nodes.filter((n) => n.source === "ai");
      expect(aiNodes.some((n) => n.text.includes("X"))).toBe(true);
      editor.destroy();
    });
  });
});
