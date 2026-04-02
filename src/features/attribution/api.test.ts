import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "./AuthorshipMark";
import { spansToMarkData } from "./api";
import type { AuthorshipSpan } from "@/db/schema";

function createTestEditor(content = "") {
  return new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content,
  });
}

describe("spansToMarkData", () => {
  it("converts DB rows to mark-compatible data", () => {
    const spans: AuthorshipSpan[] = [
      {
        id: "span-1",
        nodeId: "node-1",
        codexEntryId: null,
        snippetId: null,
        fromPos: 0,
        toPos: 10,
        source: "ai",
        model: "anthropic/claude-sonnet-4-6",
        timestamp: "2026-03-31T00:00:00.000Z",
        chatMsgId: "msg-1",
      },
      {
        id: "span-2",
        nodeId: "node-1",
        codexEntryId: null,
        snippetId: null,
        fromPos: 10,
        toPos: 20,
        source: "human",
        model: null,
        timestamp: "2026-03-31T00:00:00.000Z",
        chatMsgId: null,
      },
    ];

    const markData = spansToMarkData(spans);

    expect(markData).toHaveLength(2);

    expect(markData[0].from).toBe(0);
    expect(markData[0].to).toBe(10);
    expect(markData[0].attrs.source).toBe("ai");
    expect(markData[0].attrs.model).toBe("anthropic/claude-sonnet-4-6");
    expect(markData[0].attrs.chatMessageId).toBe("msg-1");

    expect(markData[1].from).toBe(10);
    expect(markData[1].to).toBe(20);
    expect(markData[1].attrs.source).toBe("human");
    expect(markData[1].attrs.model).toBeNull();
  });

  it("returns empty array for no spans", () => {
    expect(spansToMarkData([])).toEqual([]);
  });
});

describe("extractDbSpans via saveAuthorshipSpans round-trip positions", () => {
  it("preserves ProseMirror positions across multiple paragraphs", () => {
    const html = "<p>手書きの文章</p><p>AIの文章</p><p>編集済み</p>";
    const editor = createTestEditor(html);
    const authorshipType = editor.schema.marks["authorship"];

    // Find actual ProseMirror positions of each paragraph's text
    const textPositions: { pos: number; end: number; text: string }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.isText) {
        textPositions.push({
          pos,
          end: pos + (node.text?.length ?? 0),
          text: node.text ?? "",
        });
      }
    });
    expect(textPositions).toHaveLength(3);

    const p2 = textPositions[1]; // "AIの文章"
    const p3 = textPositions[2]; // "編集済み"

    // Mark 2nd paragraph as "ai" and 3rd as "unknown"
    editor
      .chain()
      .command(({ tr }) => {
        tr.setMeta("programmaticInsert", true);
        tr.addMark(p2.pos, p2.end, authorshipType.create({ source: "ai" }));
        tr.addMark(
          p3.pos,
          p3.end,
          authorshipType.create({ source: "unknown" }),
        );
        return true;
      })
      .run();

    // Extract spans (simulating extractDbSpans) using pos from descendants
    const savedSpans: { from: number; to: number; source: string }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText) return;
      const mark = node.marks.find((m) => m.type.name === "authorship");
      if (mark) {
        savedSpans.push({
          from: pos,
          to: pos + (node.text?.length ?? 0),
          source: mark.attrs.source as string,
        });
      }
    });

    expect(savedSpans).toHaveLength(2);
    expect(savedSpans[0]).toEqual({
      from: p2.pos,
      to: p2.end,
      source: "ai",
    });
    expect(savedSpans[1]).toEqual({
      from: p3.pos,
      to: p3.end,
      source: "unknown",
    });

    // Simulate restoration into a fresh editor (same content)
    const editor2 = createTestEditor(html);
    const authorshipType2 = editor2.schema.marks["authorship"];
    editor2
      .chain()
      .command(({ tr }) => {
        tr.setMeta("programmaticInsert", true);
        for (const span of savedSpans) {
          tr.addMark(
            span.from,
            span.to,
            authorshipType2.create({ source: span.source }),
          );
        }
        return true;
      })
      .run();

    // Verify marks are on the correct text
    const restoredSpans: { text: string; source: string }[] = [];
    editor2.state.doc.descendants((node) => {
      if (!node.isText) return;
      const mark = node.marks.find((m) => m.type.name === "authorship");
      if (mark) {
        restoredSpans.push({
          text: node.text ?? "",
          source: mark.attrs.source as string,
        });
      }
    });

    expect(restoredSpans).toEqual([
      { text: "AIの文章", source: "ai" },
      { text: "編集済み", source: "unknown" },
    ]);

    editor.destroy();
    editor2.destroy();
  });
});

describe("mark application", () => {
  it("applies restored marks to editor document", () => {
    const editor = createTestEditor("<p>テスト文章です</p>");

    const authorshipType = editor.schema.marks["authorship"];
    expect(authorshipType).toBeDefined();

    // Simulate restoring a mark on "テスト" (chars 0-3, doc pos 1-4)
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setMeta("programmaticInsert", true);
        tr.addMark(
          1,
          4,
          authorshipType.create({
            source: "ai",
            model: "anthropic/claude-sonnet-4-6",
          }),
        );
        return true;
      })
      .run();

    let foundAiMark = false;
    editor.state.doc.descendants((node) => {
      if (node.isText) {
        const mark = node.marks.find((m) => m.type.name === "authorship");
        if (mark && mark.attrs.source === "ai") {
          foundAiMark = true;
        }
      }
    });
    expect(foundAiMark).toBe(true);
    editor.destroy();
  });
});
