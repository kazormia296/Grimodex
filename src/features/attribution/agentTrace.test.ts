import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "./AuthorshipMark";
import {
  extractSpans,
  sha256,
  buildAgentTraceRecord,
  serializeRecord,
} from "./agentTrace";

function createTestEditor(content = "") {
  return new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content,
  });
}

describe("extractSpans", () => {
  it("returns human span for unmarked text", () => {
    const editor = createTestEditor("<p>普通のテキスト</p>");
    const spans = extractSpans(editor.state.doc);
    expect(spans).toHaveLength(1);
    expect(spans[0].source).toBe("human");
    expect(spans[0].start).toBe(0);
    expect(spans[0].end).toBe(7);
    editor.destroy();
  });

  it("extracts ai-marked spans with attributes", () => {
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "AI文章",
          marks: [
            {
              type: "authorship",
              attrs: {
                source: "ai",
                model: "anthropic/claude-sonnet-4-6",
                traceId: "trace-1",
                toolName: "grimodex",
                toolVersion: "0.1.0",
              },
            },
          ],
        },
      ])
      .run();

    const spans = extractSpans(editor.state.doc);
    expect(spans).toHaveLength(1);
    expect(spans[0].source).toBe("ai");
    expect(spans[0].model).toBe("anthropic/claude-sonnet-4-6");
    expect(spans[0].traceId).toBe("trace-1");
    expect(spans[0].toolName).toBe("grimodex");
    editor.destroy();
  });

  it("merges adjacent spans with same attributes", () => {
    const editor = createTestEditor();
    // Insert two separate text nodes with same ai source — they should merge
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "前半",
          marks: [
            {
              type: "authorship",
              attrs: { source: "ai", model: "m1" },
            },
          ],
        },
        {
          type: "text",
          text: "後半",
          marks: [
            {
              type: "authorship",
              attrs: { source: "ai", model: "m1" },
            },
          ],
        },
      ])
      .run();

    const spans = extractSpans(editor.state.doc);
    expect(spans).toHaveLength(1);
    expect(spans[0].start).toBe(0);
    expect(spans[0].end).toBe(4);
    editor.destroy();
  });

  it("keeps separate spans for different sources", () => {
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
              attrs: { source: "ai" },
            },
          ],
        },
      ])
      .run();

    const spans = extractSpans(editor.state.doc);
    expect(spans).toHaveLength(2);
    expect(spans[0].source).toBe("human");
    expect(spans[1].source).toBe("ai");
    editor.destroy();
  });

  it("includes manualOverride flag", () => {
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "手動",
          marks: [
            {
              type: "authorship",
              attrs: { source: "human", manualOverride: true },
            },
          ],
        },
      ])
      .run();

    const spans = extractSpans(editor.state.doc);
    expect(spans[0].manualOverride).toBe(true);
    editor.destroy();
  });
});

describe("sha256", () => {
  it("computes correct hash for known input", async () => {
    // SHA-256 of empty string
    const hash = await sha256("");
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("computes hash for Japanese text", async () => {
    const hash = await sha256("テスト");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildAgentTraceRecord", () => {
  it("builds a complete record with correct structure", async () => {
    const editor = createTestEditor();
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "テスト文",
          marks: [
            {
              type: "authorship",
              attrs: { source: "ai", model: "anthropic/claude-sonnet-4-6" },
            },
          ],
        },
      ])
      .run();

    const record = await buildAgentTraceRecord(
      editor.state.doc,
      "scene-1",
      "第一章",
    );

    expect(record.version).toBe("0.1.0");
    expect(record.type).toBe("application/vnd.agent-trace.record+json");
    expect(record.documentId).toBe("scene-1");
    expect(record["dev.grimodex.documentTitle"]).toBe("第一章");
    expect(record.contentHash).toHaveLength(64);
    expect(record.totalChars).toBe(4);
    expect(record.spans.length).toBeGreaterThan(0);
    expect(record.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    editor.destroy();
  });
});

describe("serializeRecord", () => {
  it("produces valid JSON", async () => {
    const editor = createTestEditor("<p>テスト</p>");
    const record = await buildAgentTraceRecord(editor.state.doc, "s1", "t1");
    const json = serializeRecord(record);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe("0.1.0");
    expect(parsed.spans).toBeInstanceOf(Array);
    editor.destroy();
  });
});
