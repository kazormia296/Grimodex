import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "./AuthorshipMark";

function createTestEditor(content = "") {
  return new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content,
  });
}

describe("AuthorshipMark", () => {
  it("registers as a mark extension", () => {
    const editor = createTestEditor();
    const mark = editor.schema.marks["authorship"];
    expect(mark).toBeDefined();
    editor.destroy();
  });

  it("has source, timestamp, model, and chatMessageId attributes", () => {
    const editor = createTestEditor();
    const markType = editor.schema.marks["authorship"];
    const attrs = markType.spec.attrs!;
    expect(attrs).toHaveProperty("source");
    expect(attrs).toHaveProperty("timestamp");
    expect(attrs).toHaveProperty("model");
    expect(attrs).toHaveProperty("chatMessageId");
    editor.destroy();
  });

  it("defaults source to 'human'", () => {
    const editor = createTestEditor();
    const markType = editor.schema.marks["authorship"];
    const instance = markType.create({});
    expect(instance.attrs.source).toBe("human");
    editor.destroy();
  });

  it("applies ai mark via insertContent with marks", () => {
    const editor = createTestEditor("<p>既存テキスト</p>");
    editor
      .chain()
      .focus()
      .insertContentAt(1, [
        {
          type: "text",
          text: "AI生成",
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

    // Verify the inserted text has the authorship mark
    const doc = editor.state.doc;
    let foundAiMark = false;
    doc.descendants((node) => {
      if (node.isText) {
        const mark = node.marks.find((m) => m.type.name === "authorship");
        if (mark && mark.attrs.source === "ai") {
          foundAiMark = true;
          expect(mark.attrs.chatMessageId).toBe("msg-1");
        }
      }
    });
    expect(foundAiMark).toBe(true);
    editor.destroy();
  });

  it("preserves ai-edited source value", () => {
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "編集済み",
          marks: [
            {
              type: "authorship",
              attrs: {
                source: "ai-edited",
                timestamp: "2026-03-31T00:00:00.000Z",
              },
            },
          ],
        },
      ])
      .run();

    let foundMark = false;
    editor.state.doc.descendants((node) => {
      if (node.isText) {
        const mark = node.marks.find((m) => m.type.name === "authorship");
        if (mark && mark.attrs.source === "ai-edited") {
          foundMark = true;
        }
      }
    });
    expect(foundMark).toBe(true);
    editor.destroy();
  });

  it("renders without visible HTML changes (excluded from output)", () => {
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "テスト",
          marks: [
            {
              type: "authorship",
              attrs: { source: "human" },
            },
          ],
        },
      ])
      .run();

    // The mark should render as a span with data attributes, not affecting visible text
    const html = editor.getHTML();
    expect(html).toContain("テスト");
    editor.destroy();
  });

  it("stores model attribute for ai source", () => {
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "モデル付き",
          marks: [
            {
              type: "authorship",
              attrs: {
                source: "ai",
                model: "claude-sonnet-4.6",
                timestamp: "2026-03-31T00:00:00.000Z",
              },
            },
          ],
        },
      ])
      .run();

    let modelValue: string | null = null;
    editor.state.doc.descendants((node) => {
      if (node.isText) {
        const mark = node.marks.find((m) => m.type.name === "authorship");
        if (mark && mark.attrs.model) {
          modelValue = mark.attrs.model;
        }
      }
    });
    expect(modelValue).toBe("claude-sonnet-4.6");
    editor.destroy();
  });
});
