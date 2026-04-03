// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "./AuthorshipMark";
import { computeAttributionStats } from "./attributionStats";

function createTestEditor(content = "") {
  return new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content,
  });
}

describe("computeAttributionStats", () => {
  it("returns zero stats for empty document", () => {
    const editor = createTestEditor();
    const stats = computeAttributionStats(editor.state.doc);
    expect(stats.total).toBe(0);
    expect(stats.human).toBe(0);
    expect(stats.ai).toBe(0);
    editor.destroy();
  });

  it("counts unmarked text correctly", () => {
    const editor = createTestEditor("<p>テスト文章</p>");
    const stats = computeAttributionStats(editor.state.doc);
    expect(stats.unmarked).toBe(stats.total);
    expect(stats.total).toBeGreaterThan(0);
    editor.destroy();
  });

  it("counts AI-sourced text", () => {
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "AI生成テキスト",
          marks: [
            {
              type: "authorship",
              attrs: { source: "ai", timestamp: "2026-03-31T00:00:00.000Z" },
            },
          ],
        },
      ])
      .run();

    const stats = computeAttributionStats(editor.state.doc);
    expect(stats.ai).toBeGreaterThanOrEqual(7);
    expect(stats.ai).toBe(stats.total - stats.unmarked);
    editor.destroy();
  });

  it("counts unknown sources correctly", () => {
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "人間",
          marks: [
            {
              type: "authorship",
              attrs: { source: "human" },
            },
          ],
        },
        {
          type: "text",
          text: "AI",
          marks: [
            {
              type: "authorship",
              attrs: { source: "ai", timestamp: "t" },
            },
          ],
        },
        {
          type: "text",
          text: "編集",
          marks: [
            {
              type: "authorship",
              attrs: { source: "unknown", timestamp: "t" },
            },
          ],
        },
      ])
      .run();

    const stats = computeAttributionStats(editor.state.doc);
    expect(stats.human).toBe(2);
    expect(stats.ai).toBe(2);
    expect(stats.unknown).toBe(2);
    expect(stats.total).toBe(6);
    editor.destroy();
  });

  it("counts unknown-sourced text", () => {
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "不明テキスト",
          marks: [
            {
              type: "authorship",
              attrs: { source: "unknown" },
            },
          ],
        },
      ])
      .run();

    const stats = computeAttributionStats(editor.state.doc);
    expect(stats.unknown).toBe(6);
    editor.destroy();
  });
});
