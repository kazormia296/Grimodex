import { describe, it, expect } from "vitest";
import { computeSpotlightCandidates, _internals } from "./spotlightSuggestion";
import type { CodexEntry } from "@/features/codex/api";

const { extractTextLen, scoreCandidate } = _internals;

function entry(overrides: Partial<CodexEntry> & { id: string }): CodexEntry {
  return {
    projectId: "p1",
    type: "character",
    name: overrides.id,
    aliases: [],
    excludedAliases: [],
    summary: null,
    content: '{"type":"doc","content":[]}',
    icon: null,
    tagsCache: null,
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    parentId: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  } as CodexEntry;
}

function doc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

const LONG_TEXT = "a".repeat(40);
const SHORT_TEXT = "abc";

describe("extractTextLen", () => {
  it("returns 0 for empty doc", () => {
    expect(extractTextLen('{"type":"doc","content":[]}')).toBe(0);
  });

  it("returns 0 for paragraph with no text node (advisor false-positive case)", () => {
    expect(
      extractTextLen('{"type":"doc","content":[{"type":"paragraph"}]}'),
    ).toBe(0);
  });

  it("sums text node lengths recursively", () => {
    expect(extractTextLen(doc("hello"))).toBe(5);
  });

  it("returns 0 for invalid JSON", () => {
    expect(extractTextLen("not json")).toBe(0);
  });

  it("returns 0 for null/empty", () => {
    expect(extractTextLen(null)).toBe(0);
    expect(extractTextLen("")).toBe(0);
  });
});

describe("scoreCandidate", () => {
  it("scores 0 when text length below threshold", () => {
    expect(
      scoreCandidate(entry({ id: "a", content: doc(SHORT_TEXT) }), true),
    ).toBe(0);
  });

  it("scores 4 (max) when no summary AND detected AND has content", () => {
    expect(
      scoreCandidate(
        entry({ id: "a", content: doc(LONG_TEXT), summary: null }),
        true,
      ),
    ).toBe(4);
  });

  it("scores 3 when no summary AND always-mode (not detected)", () => {
    expect(
      scoreCandidate(
        entry({ id: "a", content: doc(LONG_TEXT), summary: null }),
        false,
      ),
    ).toBe(3);
  });

  it("scores 2 when has summary but is detected", () => {
    expect(
      scoreCandidate(
        entry({ id: "a", content: doc(LONG_TEXT), summary: "x" }),
        true,
      ),
    ).toBe(2);
  });

  it("scores 1 when has summary AND not detected (no special reason)", () => {
    expect(
      scoreCandidate(
        entry({ id: "a", content: doc(LONG_TEXT), summary: "x" }),
        false,
      ),
    ).toBe(1);
  });

  it("treats whitespace-only summary as empty", () => {
    expect(
      scoreCandidate(
        entry({ id: "a", content: doc(LONG_TEXT), summary: "   " }),
        false,
      ),
    ).toBe(3);
  });
});

describe("computeSpotlightCandidates", () => {
  it("excludes entries below score threshold (has summary, always-mode)", () => {
    const e = entry({
      id: "low",
      content: doc(LONG_TEXT),
      summary: "has summary",
    });
    const candidates = computeSpotlightCandidates([], [e], new Set());
    expect(candidates.size).toBe(0);
  });

  it("includes entries with no summary even when not detected", () => {
    const e = entry({
      id: "promoted",
      content: doc(LONG_TEXT),
      summary: null,
    });
    const candidates = computeSpotlightCandidates([], [e], new Set());
    expect(Array.from(candidates)).toEqual(["promoted"]);
  });

  it("ranks higher score first when capping", () => {
    const high = entry({
      id: "high",
      content: doc(LONG_TEXT),
      summary: null,
    });
    const mid = entry({
      id: "mid",
      content: doc(LONG_TEXT),
      summary: "has summary",
    });
    const candidates = computeSpotlightCandidates([mid], [high], new Set(), 1);
    expect(Array.from(candidates)).toEqual(["high"]);
  });

  it("excludes pinned entries", () => {
    const e = entry({ id: "p", content: doc(LONG_TEXT), summary: null });
    const candidates = computeSpotlightCandidates([e], [], new Set(["p"]));
    expect(candidates.size).toBe(0);
  });

  it("dedups when same id appears in both detected and always", () => {
    const e = entry({ id: "dup", content: doc(LONG_TEXT), summary: null });
    const candidates = computeSpotlightCandidates([e], [e], new Set());
    expect(candidates.size).toBe(1);
  });

  it("rejects empty paragraph (advisor false-positive case)", () => {
    const e = entry({
      id: "empty-p",
      content: '{"type":"doc","content":[{"type":"paragraph"}]}',
      summary: null,
    });
    const candidates = computeSpotlightCandidates([e], [], new Set());
    expect(candidates.size).toBe(0);
  });

  it("caps at maxCandidates", () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      entry({ id: `e${i}`, content: doc(LONG_TEXT), summary: null }),
    );
    const candidates = computeSpotlightCandidates(entries, [], new Set(), 2);
    expect(candidates.size).toBe(2);
  });
});
