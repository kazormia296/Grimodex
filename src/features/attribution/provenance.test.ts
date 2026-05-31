import { describe, expect, it } from "vitest";
import {
  buildSceneLabelMap,
  excerptFromPmJson,
  resolveProvenanceFromLookups,
} from "./provenance";
import type { GenerationLogLookup, SpanRef } from "./provenance";
import type { ProjectAuthorshipReport } from "./projectAuthorship";

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
