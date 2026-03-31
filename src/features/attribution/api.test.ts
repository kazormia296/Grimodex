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
        id: 1,
        sceneId: "scene-1",
        offsetStart: 0,
        offsetEnd: 10,
        source: "ai",
        traceId: "trace-1",
        model: "anthropic/claude-sonnet-4-6",
        aiMessageId: "msg-1",
        manualOverride: 0,
        contentHash: "abc123",
        toolName: "noveloom",
        toolVersion: "0.1.0",
        createdAt: "2026-03-31T00:00:00.000Z",
      },
      {
        id: 2,
        sceneId: "scene-1",
        offsetStart: 10,
        offsetEnd: 20,
        source: "human",
        traceId: null,
        model: null,
        aiMessageId: null,
        manualOverride: 1,
        contentHash: "abc123",
        toolName: null,
        toolVersion: null,
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    ];

    const markData = spansToMarkData(spans);

    expect(markData).toHaveLength(2);

    expect(markData[0].from).toBe(0);
    expect(markData[0].to).toBe(10);
    expect(markData[0].attrs.source).toBe("ai");
    expect(markData[0].attrs.model).toBe("anthropic/claude-sonnet-4-6");
    expect(markData[0].attrs.manualOverride).toBe(false);
    expect(markData[0].attrs.toolName).toBe("noveloom");

    expect(markData[1].from).toBe(10);
    expect(markData[1].to).toBe(20);
    expect(markData[1].attrs.source).toBe("human");
    expect(markData[1].attrs.manualOverride).toBe(true);
  });

  it("returns empty array for no spans", () => {
    expect(spansToMarkData([])).toEqual([]);
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
