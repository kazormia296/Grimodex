// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark, normalizeModelId } from "./AuthorshipMark";

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

  it("inherits at the cursor boundary so IME composition stays in one DOM span", () => {
    const editor = createTestEditor();
    const mark = editor.schema.marks["authorship"];
    expect(mark.spec.inclusive).toBe(true);
    editor.destroy();
  });

  it("has all Agent Trace attributes", () => {
    const editor = createTestEditor();
    const markType = editor.schema.marks["authorship"];
    const attrs = markType.spec.attrs!;
    expect(attrs).toHaveProperty("source");
    expect(attrs).toHaveProperty("timestamp");
    expect(attrs).toHaveProperty("model");
    expect(attrs).toHaveProperty("chatMessageId");
    expect(attrs).toHaveProperty("traceId");
    expect(attrs).toHaveProperty("toolName");
    expect(attrs).toHaveProperty("toolVersion");
    expect(attrs).toHaveProperty("manualOverride");
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

  it("preserves unknown source value", () => {
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
                source: "unknown",
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
        if (mark && mark.attrs.source === "unknown") {
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

  it("preserves unknown source value", () => {
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "ペースト",
          marks: [
            {
              type: "authorship",
              attrs: { source: "unknown" },
            },
          ],
        },
      ])
      .run();

    let foundMark = false;
    editor.state.doc.descendants((node) => {
      if (node.isText) {
        const mark = node.marks.find((m) => m.type.name === "authorship");
        if (mark && mark.attrs.source === "unknown") {
          foundMark = true;
        }
      }
    });
    expect(foundMark).toBe(true);
    editor.destroy();
  });

  it("stores Agent Trace attributes (traceId, toolName, toolVersion)", () => {
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "トレース",
          marks: [
            {
              type: "authorship",
              attrs: {
                source: "ai",
                traceId: "trace-001",
                toolName: "grimodex",
                toolVersion: "0.1.0",
              },
            },
          ],
        },
      ])
      .run();

    let attrs: Record<string, unknown> = {};
    editor.state.doc.descendants((node) => {
      if (node.isText) {
        const mark = node.marks.find((m) => m.type.name === "authorship");
        if (mark && mark.attrs.traceId) {
          attrs = mark.attrs;
        }
      }
    });
    expect(attrs.traceId).toBe("trace-001");
    expect(attrs.toolName).toBe("grimodex");
    expect(attrs.toolVersion).toBe("0.1.0");
    editor.destroy();
  });
});

describe("normalizeModelId", () => {
  it("prepends provider when model has no slash", () => {
    expect(normalizeModelId("anthropic", "claude-sonnet-4-6")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
  });

  it("returns as-is when model already has slash", () => {
    expect(normalizeModelId("openrouter", "anthropic/claude-sonnet-4-6")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
  });
});
