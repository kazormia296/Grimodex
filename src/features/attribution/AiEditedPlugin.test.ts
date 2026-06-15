// @vitest-environment happy-dom
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

function insertUnknownText(editor: Editor, text: string) {
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
              source: "unknown",
              timestamp: new Date().toISOString(),
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

  // --- Basic behavior ---

  it("does not reclassify on programmatic insert", () => {
    insertAiText(editor, "AI生成テキスト");
    const sources = findAuthorshipSources(editor);
    expect(sources).toContain("ai");
    editor.destroy();
  });

  it("does not reclassify human text", () => {
    editor.chain().focus().insertContent("人間テキスト").run();
    const sources = findAuthorshipSources(editor);
    expect(sources).not.toContain("ai");
    editor.destroy();
  });

  it("does not split ai text with manualOverride", () => {
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

    editor
      .chain()
      .focus()
      .insertContentAt(aiPos + 1, "追加")
      .run();

    const sources = findAuthorshipSources(editor);
    expect(sources).toContain("ai");
    editor.destroy();
  });

  // --- Adjacent node isolation ---

  it("editing one node does NOT affect adjacent nodes", () => {
    const text = "承知しました。「これは生成AIの生成した文章です。」";
    insertAiText(editor, text, "msg-1");
    insertAiText(editor, text, "msg-2");
    insertAiText(editor, text, "msg-3");

    // Find 2nd node and insert a char (splits it)
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

    editor
      .chain()
      .focus()
      .setTextSelection(secondNodePos + 5)
      .insertContentAt(secondNodePos + 5, "X")
      .run();

    // All ai nodes should remain "ai" — the 2nd was split, not reclassified
    const sources = findAuthorshipSources(editor);
    const aiCount = sources.filter((s) => s === "ai").length;
    // 1st node (1) + 2nd node split into 2 flanking ai nodes + 3rd node (1) = 4
    expect(aiCount).toBe(4);
    editor.destroy();
  });

  it("inclusive:false prevents mark inheritance at insertion boundary", () => {
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
      if (mark)
        nodes.push({ traceId: mark.attrs.traceId, source: mark.attrs.source });
    });
    expect(nodes).toHaveLength(3);
    expect(nodes[0].traceId).toBe("trace-0");
    expect(nodes[1].traceId).toBe("trace-1");
    expect(nodes[2].traceId).toBe("trace-2");

    // Delete 1 char from 2nd node — mark stays "ai"
    let nodeCount = 0;
    let secondPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText) return;
      nodeCount++;
      if (nodeCount === 2) secondPos = pos;
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
    expect(after[1].source).toBe("ai");
    expect(after[2].source).toBe("ai");
    editor.destroy();
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

      const relevantNodes = nodes.filter((n) => n.text !== "テスト文章");
      expect(relevantNodes).toHaveLength(3);
      expect(relevantNodes[0]).toEqual({ text: "Hello", source: "ai" });
      expect(relevantNodes[1]).toEqual({ text: "XYZ", source: null });
      expect(relevantNodes[2]).toEqual({ text: "World", source: "ai" });
      editor.destroy();
    });

    it("keeps AI mark on flanking text after insertion (no reclassification)", () => {
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
        .insertContentAt(aiPos + 2, "X")
        .run();

      const sources = findAuthorshipSources(editor);
      expect(sources).toContain("ai");
      editor.destroy();
    });

    it("deletion does not change ai source", () => {
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
      expect(sources).toContain("ai");
      editor.destroy();
    });

    it("中間文字を削除後 undo で復元しても ai のまま (Issue 1: undo reclassify)", () => {
      editor.destroy();
      editor = createTestEditor("<p></p>");
      // ai テキストを履歴に載せず seed (undo 対象を delete のみに隔離)
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setMeta("programmaticInsert", true);
          tr.setMeta("addToHistory", false);
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
                  chatMessageId: "m",
                  timestamp: new Date().toISOString(),
                  originalLength: 5,
                },
              },
            ],
          },
        ])
        .run();

      // 中間 "C" (pos 3-4) を削除 (履歴に載る user 操作)
      editor.commands.deleteRange({ from: 3, to: 4 });
      expect(editor.state.doc.textContent).toBe("ABDE");

      // undo で "C" を復元
      editor.commands.undo();
      expect(editor.state.doc.textContent).toBe("ABCDE");

      // 復元後、全テキストが ai のまま (human 化していない)
      const runs: { text: string; source: string }[] = [];
      editor.state.doc.descendants((node) => {
        if (!node.isText) return;
        const mark = node.marks.find((m) => m.type.name === "authorship");
        runs.push({
          text: node.text ?? "",
          source: mark ? (mark.attrs.source as string) : "(none)",
        });
      });
      expect(runs.every((r) => r.source === "ai")).toBe(true);
      editor.destroy();
    });

    it("splits unknown span on insertion (same as ai)", () => {
      insertUnknownText(editor, "HelloWorld");

      let unknownPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "HelloWorld") unknownPos = pos;
      });
      expect(unknownPos).toBeGreaterThan(0);

      editor
        .chain()
        .focus()
        .setTextSelection(unknownPos + 5)
        .insertContentAt(unknownPos + 5, "XYZ")
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

      const relevantNodes = nodes.filter((n) => n.text !== "テスト文章");
      expect(relevantNodes).toHaveLength(3);
      expect(relevantNodes[0]).toEqual({ text: "Hello", source: "unknown" });
      expect(relevantNodes[1]).toEqual({ text: "XYZ", source: null });
      expect(relevantNodes[2]).toEqual({ text: "World", source: "unknown" });
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

      const sources = findAuthorshipSources(editor);
      expect(sources).toContain("ai");
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

      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setMeta("programmaticInsert", true);
          return true;
        })
        .insertContentAt(aiPos + 2, "X")
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

      const aiNodes = nodes.filter((n) => n.source === "ai");
      expect(aiNodes.some((n) => n.text.includes("X"))).toBe(true);
      editor.destroy();
    });

    it("splitting AI node with Enter preserves marks on both halves", () => {
      // Regression: slice.content.size included structural tokens (openStart/openEnd),
      // causing removeMark to strip the first 1-2 chars of the second paragraph.
      const ed = createTestEditor();
      insertAiText(ed, "HelloWorld");

      let aiPos = -1;
      ed.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === "HelloWorld") aiPos = pos;
      });
      expect(aiPos).toBeGreaterThan(0);

      // Split the paragraph at position between "Hello" and "World"
      const splitPos = aiPos + 5;
      ed.chain()
        .focus()
        .setTextSelection(splitPos)
        .command(({ tr, state }) => {
          tr.split(state.selection.from);
          return true;
        })
        .run();

      const nodes: { text: string; source: string | null }[] = [];
      ed.state.doc.descendants((node) => {
        if (!node.isText) return;
        const mark = node.marks.find((m) => m.type.name === "authorship");
        nodes.push({
          text: node.text ?? "",
          source: mark ? (mark.attrs.source as string) : null,
        });
      });

      // Both halves must retain "ai" — no characters should become human
      const helloNode = nodes.find((n) => n.text === "Hello");
      const worldNode = nodes.find((n) => n.text === "World");
      expect(helloNode).toBeDefined();
      expect(worldNode).toBeDefined();
      expect(helloNode!.source).toBe("ai");
      expect(worldNode!.source).toBe("ai");
      ed.destroy();
    });
  });
});
