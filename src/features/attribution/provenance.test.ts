// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  buildSceneLabelMap,
  excerptFromPmJson,
  extractSpansFromDoc,
  resolveProvenanceFromLookups,
} from "./provenance";
import type { GenerationLogLookup, SpanRef } from "./provenance";
import type { ProjectAuthorshipReport } from "./projectAuthorship";
import { AuthorshipMark } from "./AuthorshipMark";
import { RubyNode } from "@/features/editor/RubyNode";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import { SceneBreakNode } from "@/features/editor/SceneBreakNode";

const span = (overrides: Partial<SpanRef>): SpanRef => ({
  id: "span-1",
  nodeId: "scene-1",
  from: 1,
  to: 8,
  source: "ai",
  model: null,
  chatMsgId: null,
  traceId: null,
  timestamp: null,
  ...overrides,
});

const log = (overrides: Partial<GenerationLogLookup>): GenerationLogLookup => ({
  traceId: "trace-1",
  kind: "inline-ai",
  commandId: "continue",
  instruction: "続きを書く",
  model: "claude-sonnet-4-6",
  ...overrides,
});

describe("resolveProvenanceFromLookups", () => {
  it("excludes non-AI spans", async () => {
    const passages = await resolveProvenanceFromLookups(
      [span({ source: "human" })],
      {
        generationLogs: new Map(),
        chatMessages: new Map(),
        precedingUserPrompts: new Map(),
      },
      () => "本文",
    );

    expect(passages).toEqual([]);
  });

  it("prefers trace_id over chat_msg_id", async () => {
    const passages = await resolveProvenanceFromLookups(
      [span({ traceId: "trace-1", chatMsgId: "msg-1" })],
      {
        generationLogs: new Map([["trace-1", log({ kind: "beat" })]]),
        chatMessages: new Map([
          [
            "msg-1",
            {
              id: "msg-1",
              sessionId: "sess-1",
              role: "assistant",
              content: "assistant text",
              model: "chat-model",
              createdAt: "2026-01-01T00:00:01.000Z",
            },
          ],
        ]),
        precedingUserPrompts: new Map([["msg-1", "user prompt"]]),
      },
      () => "本文",
    );

    expect(passages[0].provenance.kind).toBe("beat");
    expect(passages[0].provenance.chatMessage).toBeUndefined();
  });

  it("resolves chat provenance and preceding user prompt", async () => {
    const passages = await resolveProvenanceFromLookups(
      [span({ chatMsgId: "msg-1" })],
      {
        generationLogs: new Map(),
        chatMessages: new Map([
          [
            "msg-1",
            {
              id: "msg-1",
              sessionId: "sess-1",
              role: "assistant",
              content: "assistant text",
              model: "chat-model",
              createdAt: "2026-01-01T00:00:01.000Z",
            },
          ],
        ]),
        precedingUserPrompts: new Map([["msg-1", "user prompt"]]),
      },
      () => "本文",
    );

    expect(passages[0].provenance.kind).toBe("chat");
    expect(passages[0].provenance.chatMessage?.content).toBe("assistant text");
    expect(passages[0].provenance.precedingUserPrompt).toBe("user prompt");
  });

  it("marks missing chat messages as orphan-chat", async () => {
    const passages = await resolveProvenanceFromLookups(
      [span({ chatMsgId: "deleted-msg" })],
      {
        generationLogs: new Map(),
        chatMessages: new Map(),
        precedingUserPrompts: new Map(),
      },
      () => "本文",
    );

    expect(passages[0].provenance.kind).toBe("orphan-chat");
  });

  it("falls back to unknown when no provenance signal is available", async () => {
    const passages = await resolveProvenanceFromLookups(
      [span({})],
      {
        generationLogs: new Map(),
        chatMessages: new Map(),
        precedingUserPrompts: new Map(),
      },
      () => "本文",
    );

    expect(passages[0].provenance.kind).toBe("unknown");
  });

  it("keeps split spans from the same trace as separate passages", async () => {
    const passages = await resolveProvenanceFromLookups(
      [
        span({ id: "span-1", traceId: "trace-1", from: 1, to: 4 }),
        span({ id: "span-2", traceId: "trace-1", from: 8, to: 12 }),
      ],
      {
        generationLogs: new Map([["trace-1", log({})]]),
        chatMessages: new Map(),
        precedingUserPrompts: new Map(),
      },
      (_nodeId, from, to) => `${from}-${to}`,
    );

    expect(passages).toHaveLength(2);
    expect(passages.map((p) => p.provenance.traceId)).toEqual([
      "trace-1",
      "trace-1",
    ]);
    expect(passages.map((p) => p.excerpt)).toEqual(["1-4", "8-12"]);
  });
});

describe("buildSceneLabelMap", () => {
  const emptyTotals = {
    human: 0,
    ai: 0,
    unknown: 0,
    unmarked: 0,
    total: 0,
    humanRatio: 0,
  };
  const report: ProjectAuthorshipReport = {
    projectId: "p1",
    projectTitle: "Title",
    generatedAt: "2026-05-31T00:00:00.000Z",
    scope: "body-text-only",
    totals: emptyTotals,
    chapters: [
      {
        id: "ch1",
        title: "Prologue",
        totals: emptyTotals,
        scenes: [{ id: "s1", title: "Opening", totals: emptyTotals }],
      },
    ],
    unparentedScenes: [{ id: "s2", title: "Loose scene", totals: emptyTotals }],
  };

  it("maps chaptered scenes to {sceneTitle, chapterTitle}", () => {
    const labels = buildSceneLabelMap(report);
    expect(labels.get("s1")).toEqual({
      sceneTitle: "Opening",
      chapterTitle: "Prologue",
    });
  });

  it("marks unparented scenes with chapterTitle=null", () => {
    const labels = buildSceneLabelMap(report);
    expect(labels.get("s2")).toEqual({
      sceneTitle: "Loose scene",
      chapterTitle: null,
    });
  });
});

describe("excerptFromPmJson", () => {
  // Helpers: build PM JSON. Positions used in expectations follow the
  // ProseMirror standard (same coordinates as extractDbSpans saves to DB).
  const wrap = (content: unknown[]) => JSON.stringify({ type: "doc", content });
  const p = (text: string) => ({
    type: "paragraph",
    content: text ? [{ type: "text", text }] : [],
  });

  it("returns empty for empty content", () => {
    expect(excerptFromPmJson("", 0, 5)).toBe("");
    expect(excerptFromPmJson("{}", 0, 5)).toBe("");
  });

  it("extracts text using ProseMirror standard positions", () => {
    // doc { paragraph { "Hello" } }: paragraph opens at 0, text at pos 1..6.
    // extractDbSpans saves fromPos=1, toPos=6 for the text node.
    expect(excerptFromPmJson(wrap([p("Hello")]), 1, 6)).toBe("Hello");
  });

  it("extracts a partial range from the middle of a paragraph", () => {
    // text at 1..6; positions 2..5 = "ell"
    expect(excerptFromPmJson(wrap([p("Hello")]), 2, 5)).toBe("ell");
  });

  it("extracts text across two paragraphs", () => {
    // doc { p "abc", p "xyz" }: "abc" at 1..4, p1 close at 5,
    // p2 opens at 5, "xyz" at 6..9, p2 close at 10. Total size = 10.
    expect(excerptFromPmJson(wrap([p("abc"), p("xyz")]), 1, 9)).toBe("abcxyz");
  });

  it("handles empty paragraphs (size=2 in PM)", () => {
    // doc { p "abc", p "", p "xyz" }
    // "abc" at 1..4, p1 close 5, empty p2 opens 5..closes 7, p3 opens 7,
    // "xyz" at 8..11. So pos 1..11 spans both real paragraphs.
    expect(excerptFromPmJson(wrap([p("abc"), p(""), p("xyz")]), 1, 11)).toBe(
      "abcxyz",
    );
  });

  it("treats horizontalRule as a size=1 atom", () => {
    // doc { p "abc", hr, p "xyz" }
    // "abc" at 1..4, p1 close 5, hr at 5..6, p2 opens 6, "xyz" at 7..10.
    expect(
      excerptFromPmJson(
        wrap([p("abc"), { type: "horizontalRule" }, p("xyz")]),
        1,
        10,
      ),
    ).toBe("abcxyz");
  });

  it("includes ruby base text but advances cursor by size=1 (atom inline)", () => {
    // doc { p { text "前", ruby base="漢" annotation="かん", text "後" } }
    // p opens at 0, "前" at 1..2, ruby at 2..3 (atom, size=1), "後" at 3..4.
    const doc = wrap([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "前" },
          { type: "ruby", attrs: { base: "漢", annotation: "かん" } },
          { type: "text", text: "後" },
        ],
      },
    ]);
    expect(excerptFromPmJson(doc, 1, 4)).toBe("前漢後");
    // The position immediately after the ruby is 3; "後" alone is pos 3..4.
    expect(excerptFromPmJson(doc, 3, 4)).toBe("後");
  });

  it("excludes sceneBeat content from the excerpt", () => {
    // sceneBeat carries the author's structural intent, not prose.
    const doc = wrap([
      {
        type: "sceneBeat",
        content: [{ type: "text", text: "構成意図" }],
      },
      p("本文"),
    ]);
    // sceneBeat at 0..6 (open + 4 chars + close), p2 opens 6, "本文" 7..9.
    // Asking for the whole doc should yield only the prose paragraph.
    expect(excerptFromPmJson(doc, 0, 9)).toBe("本文");
  });

  it("truncates and ellipsizes long excerpts", () => {
    const longText = "あ".repeat(200);
    const result = excerptFromPmJson(wrap([p(longText)]), 1, 201);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith("...")).toBe(true);
  });
});

describe("extractSpansFromDoc → excerptFromPmJson round-trip", () => {
  // Systematic guard against off-by-one drift between the position writer
  // (extractDbSpans / extractSpansFromDoc) and the position reader
  // (excerptFromPmJson). The disclosure report shows excerpts verbatim, so
  // a 1-char shift here would publish wrong text. Builds a doc with every
  // PM-size variant the walker handles — leaf block, ruby atom, sceneBreak
  // atom, empty paragraph, sceneBeat (text suppressed) — then asserts that
  // every saved span maps back to the exact text we marked.
  function build() {
    const editor = new Editor({
      extensions: [
        StarterKit,
        AuthorshipMark,
        RubyNode,
        SceneBreakNode,
        SceneBeatNode,
      ],
    });
    const tr = editor.state.tr;
    const { schema } = editor;
    const text = (s: string) => schema.text(s);
    const para = (...children: ReturnType<typeof text>[]) =>
      schema.nodes.paragraph.create(null, children);
    const doc = schema.nodes.doc.create(null, [
      para(
        text("前"),
        schema.nodes.ruby.create({ base: "漢", annotation: "かん" }),
        text("後"),
      ),
      schema.nodes.paragraph.create(null),
      schema.nodes.sceneBreak.create(),
      para(text("本文")),
      schema.nodes.sceneBeat.create(null, [text("構成意図")]),
      para(text("末尾")),
    ]);
    tr.replaceWith(0, editor.state.doc.content.size, doc.content);
    editor.view.dispatch(tr);
    return editor;
  }

  function markRange(
    editor: Editor,
    from: number,
    to: number,
    source: "ai" | "human" | "unknown",
  ): void {
    const mark = editor.schema.marks["authorship"]!.create({ source });
    editor.view.dispatch(
      editor.state.tr
        .setMeta("programmaticInsert", true)
        .addMark(from, to, mark),
    );
  }

  function findTextPos(
    editor: Editor,
    needle: string,
  ): { from: number; to: number } {
    let found: { from: number; to: number } | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (found) return false;
      if (node.isText && node.text === needle) {
        found = { from: pos, to: pos + needle.length };
        return false;
      }
    });
    if (!found) throw new Error(`text "${needle}" not found`);
    return found;
  }

  function excerptFor(editor: Editor, span: SpanRef): string {
    const json = JSON.stringify(editor.state.doc.toJSON());
    return excerptFromPmJson(json, span.from, span.to);
  }

  it("round-trips a plain paragraph span (PM doc opening +1 + paragraph opening +1)", () => {
    const editor = build();
    const { from, to } = findTextPos(editor, "本文");
    markRange(editor, from, to, "ai");

    const spans = extractSpansFromDoc(editor.state.doc, "scene-1");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ from, to, source: "ai" });
    expect(excerptFor(editor, spans[0])).toBe("本文");
    editor.destroy();
  });

  it("round-trips a span that ends adjacent to a ruby atom (size=1)", () => {
    const editor = build();
    const before = findTextPos(editor, "前");
    const after = findTextPos(editor, "後");
    // Mark "前" + ruby base + "後" as one continuous span. Ruby is an atom of
    // size 1; walker should include base="漢" between the two text segments.
    markRange(editor, before.from, after.to, "ai");

    const spans = extractSpansFromDoc(editor.state.doc, "scene-1");
    // extractSpansFromDoc yields one entry per text node; ruby atom is not
    // text so it produces two spans flanking the ruby.
    expect(spans).toHaveLength(2);
    const joinedFrom = Math.min(...spans.map((s) => s.from));
    const joinedTo = Math.max(...spans.map((s) => s.to));
    expect(
      excerptFor(editor, { ...spans[0], from: joinedFrom, to: joinedTo }),
    ).toBe("前漢後");
    editor.destroy();
  });

  it("round-trips a span across an empty paragraph and a sceneBreak atom", () => {
    const editor = build();
    const first = findTextPos(editor, "後");
    const second = findTextPos(editor, "本文");
    // Mark "後" and "本文" separately so we have two real spans; verify that
    // each one round-trips independently, and that a synthetic span that
    // brackets both still resolves to the concatenated prose (no leakage
    // from the empty paragraph or sceneBreak in between).
    markRange(editor, first.from, first.to, "ai");
    markRange(editor, second.from, second.to, "ai");

    const spans = extractSpansFromDoc(editor.state.doc, "scene-1");
    expect(spans).toHaveLength(2);
    expect(excerptFor(editor, spans[0])).toBe("後");
    expect(excerptFor(editor, spans[1])).toBe("本文");

    const bridged: SpanRef = { ...spans[0], from: first.from, to: second.to };
    expect(excerptFor(editor, bridged)).toBe("後本文");
    editor.destroy();
  });

  it("round-trips a span inside a sceneBeat by yielding an empty excerpt", () => {
    const editor = build();
    const beat = findTextPos(editor, "構成意図");
    markRange(editor, beat.from, beat.to, "ai");

    const spans = extractSpansFromDoc(editor.state.doc, "scene-1");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ from: beat.from, to: beat.to });
    // sceneBeat text is suppressed from disclosure excerpts even though
    // the span is real (this is why projectStats can see ai > body chars).
    expect(excerptFor(editor, spans[0])).toBe("");
    editor.destroy();
  });

  it("round-trips multiple non-contiguous spans without position drift", () => {
    const editor = build();
    const first = findTextPos(editor, "本文");
    const second = findTextPos(editor, "末尾");
    markRange(editor, first.from, first.to, "ai");
    markRange(editor, second.from, second.to, "unknown");

    const spans = extractSpansFromDoc(editor.state.doc, "scene-1");
    expect(spans).toHaveLength(2);
    const bySource = Object.fromEntries(
      spans.map((s) => [s.source, s]),
    ) as Record<string, SpanRef>;
    expect(excerptFor(editor, bySource.ai)).toBe("本文");
    expect(excerptFor(editor, bySource.unknown)).toBe("末尾");
    editor.destroy();
  });
});
