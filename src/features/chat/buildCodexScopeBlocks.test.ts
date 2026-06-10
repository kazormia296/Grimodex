import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CodexEntry } from "@/features/codex/api";
import { buildCodexScopeBlocks } from "./chatStore";

vi.mock("@/features/codex/prosemirrorTextExtractor", () => ({
  extractPlainText: vi.fn((content: string) => content || ""),
}));

vi.mock("@/features/codex/phaseApi", () => ({
  listPhasesByEntryIds: vi.fn(() => Promise.resolve([])),
  listDetailOverridesByPhaseIds: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/features/codex/detailApi", () => ({
  listRawDetailValuesByEntryIds: vi.fn(() => Promise.resolve([])),
  listContextDetailsByEntryIds: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/features/codex/rustMatcher", () => ({
  findMentionedEntriesAsync: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/features/codex/codexCrossMentions", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/codex/codexCrossMentions")
    >();
  return {
    ...actual,
    findReverseMentioningEntries: vi.fn(() => []),
  };
});

vi.mock("@/features/codex/codexRelationApi", () => ({
  listCodexRelations: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: vi.fn(() => ({ nodes: [] })) },
}));

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: { getState: vi.fn(() => ({ globalSceneOrder: new Map() })) },
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: vi.fn(() => "proj-1"),
}));

import { findMentionedEntriesAsync } from "@/features/codex/rustMatcher";
import { findReverseMentioningEntries } from "@/features/codex/codexCrossMentions";
import { listCodexRelations } from "@/features/codex/codexRelationApi";

const mockFindMentioned = vi.mocked(findMentionedEntriesAsync);
const mockFindReverse = vi.mocked(findReverseMentioningEntries);
const mockListRelations = vi.mocked(listCodexRelations);

function makeEntry(
  overrides: Partial<CodexEntry> & { id: string; name: string },
): CodexEntry {
  return {
    projectId: "proj-1",
    type: "character",
    parentId: null,
    summary: "summary",
    content: "body",
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

describe("buildCodexScopeBlocks", () => {
  beforeEach(() => {
    mockFindMentioned.mockReset();
    mockFindReverse.mockReset();
    mockListRelations.mockReset();
    mockFindMentioned.mockResolvedValue([]);
    mockFindReverse.mockReturnValue([]);
    mockListRelations.mockResolvedValue([]);
  });

  it("returns null when selected entry is not in allEntries", async () => {
    const result = await buildCodexScopeBlocks({
      selectedEntryId: "missing",
      allEntries: [makeEntry({ id: "other", name: "Other" })],
    });
    expect(result).toBeNull();
  });

  it("deduplicates forward and reverse mentions in relatedMentioned", async () => {
    const selected = makeEntry({ id: "hero", name: "Hero" });
    const ally = makeEntry({ id: "ally", name: "Ally" });
    const rival = makeEntry({ id: "rival", name: "Rival" });

    mockFindMentioned.mockResolvedValue([ally, rival]);
    mockFindReverse.mockReturnValue([ally]);

    const result = await buildCodexScopeBlocks({
      selectedEntryId: "hero",
      allEntries: [selected, ally, rival],
    });

    expect(result).not.toBeNull();
    expect(result!.relatedMentioned.map((e) => e.id)).toEqual([
      "ally",
      "rival",
    ]);
    expect(result!.selectedPinned.id).toBe("hero");
    expect(result!.selectedPinned.name).toBe("Hero");
  });

  it("excludes selected entry from relatedMentioned even if matchers return it", async () => {
    const selected = makeEntry({ id: "hero", name: "Hero" });
    mockFindMentioned.mockResolvedValue([selected]);
    mockFindReverse.mockReturnValue([selected]);

    const result = await buildCodexScopeBlocks({
      selectedEntryId: "hero",
      allEntries: [selected],
    });

    expect(result!.relatedMentioned).toEqual([]);
  });

  it("skips hidden and suppress entries when detecting mentions", async () => {
    const selected = makeEntry({ id: "hero", name: "Hero" });
    const hidden = makeEntry({
      id: "hidden",
      name: "Hidden",
      contextMode: "hidden",
    });
    mockFindMentioned.mockImplementation(async (_text, candidates) =>
      candidates.filter((e) => e.id === "hidden"),
    );

    const result = await buildCodexScopeBlocks({
      selectedEntryId: "hero",
      allEntries: [selected, hidden],
    });

    expect(mockFindMentioned).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.arrayContaining([expect.objectContaining({ id: "hidden" })]),
    );
    expect(result!.relatedMentioned).toEqual([]);
  });
});
