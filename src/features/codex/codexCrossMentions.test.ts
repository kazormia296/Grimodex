import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CodexEntry } from "./api";
import {
  getEntryScanText,
  findReverseMentioningEntries,
  _clearCodexCrossMentionCaches,
} from "./codexCrossMentions";
import { extractPlainText } from "./prosemirrorTextExtractor";

vi.mock("./prosemirrorTextExtractor", () => ({
  extractPlainText: vi.fn((content: string) => `plain:${content}`),
}));

function makeEntry(
  overrides: Partial<CodexEntry> & { id: string; name: string },
): CodexEntry {
  return {
    projectId: "proj-1",
    type: "character",
    parentId: null,
    summary: null,
    content: "{}",
    contextMode: "mentioned",
    aliases: null,
    excludedAliases: null,
    tagsCache: null,
    childrenBudget: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    sourceChatMessageId: null,
    ...overrides,
  } as CodexEntry;
}

describe("getEntryScanText", () => {
  beforeEach(() => {
    _clearCodexCrossMentionCaches();
    vi.mocked(extractPlainText).mockClear();
  });

  it("caches plain text by updatedAt stamp", () => {
    const entry = makeEntry({
      id: "e1",
      name: "Alice",
      summary: "Hero",
      content: '{"type":"doc"}',
      updatedAt: "2024-01-02T00:00:00Z",
    });
    const first = getEntryScanText(entry);
    const second = getEntryScanText(entry);
    expect(first).toBe(second);
    expect(extractPlainText).toHaveBeenCalledTimes(1);
  });
});

describe("findReverseMentioningEntries", () => {
  beforeEach(() => {
    _clearCodexCrossMentionCaches();
  });

  it("detects entries that mention selected name", () => {
    const selected = { id: "hero", name: "Alice", type: "character" };
    const candidates = [
      makeEntry({
        id: "c1",
        name: "World",
        summary: "Mentions Alice in lore",
        content: "{}",
      }),
      makeEntry({
        id: "c2",
        name: "Bob",
        summary: "Unrelated",
        content: "{}",
      }),
    ];
    const result = findReverseMentioningEntries(selected, candidates);
    expect(result.map((e) => e.id)).toEqual(["c1"]);
  });

  it("memoizes results for same selection and candidates", () => {
    const selected = { id: "hero", name: "Alice", type: "character" };
    const candidates = [
      makeEntry({
        id: "c1",
        name: "World",
        summary: "Alice",
        content: "{}",
      }),
    ];
    const a = findReverseMentioningEntries(selected, candidates);
    const b = findReverseMentioningEntries(selected, candidates);
    expect(a).toBe(b);
  });
});
