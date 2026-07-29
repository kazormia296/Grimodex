import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CodexEntry } from "@/features/codex/api";
import type { CodexEntryPhase } from "@/features/codex/phaseApi";
import type { TreeNodeData } from "@/features/tree/treeStore";
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
  usePhaseStore: {
    getState: vi.fn(() => ({
      resolutionMode: "reading",
      sceneTimeIndex: {
        readingOrder: new Map(),
        explicitStoryOrder: new Map(),
        inheritedStoryOrder: new Map(),
        liveSceneCount: 0,
        scheduledSceneCount: 0,
        revision: 0,
      },
    })),
  },
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: vi.fn(() => "proj-1"),
}));

import { findMentionedEntriesAsync } from "@/features/codex/rustMatcher";
import { findReverseMentioningEntries } from "@/features/codex/codexCrossMentions";
import { listCodexRelations } from "@/features/codex/codexRelationApi";
import { listPhasesByEntryIds } from "@/features/codex/phaseApi";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";

const mockFindMentioned = vi.mocked(findMentionedEntriesAsync);
const mockFindReverse = vi.mocked(findReverseMentioningEntries);
const mockListRelations = vi.mocked(listCodexRelations);
const mockListPhases = vi.mocked(listPhasesByEntryIds);
const mockPhaseState = vi.mocked(usePhaseStore.getState);
const mockTreeState = vi.mocked(useTreeStore.getState);

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
    mockListPhases.mockResolvedValue([]);
    mockPhaseState.mockReturnValue({
      resolutionMode: "reading",
      sceneTimeIndex: {
        readingOrder: new Map(),
        explicitStoryOrder: new Map(),
        inheritedStoryOrder: new Map(),
        liveSceneCount: 0,
        scheduledSceneCount: 0,
        revision: 0,
      },
    } as ReturnType<typeof usePhaseStore.getState>);
    mockTreeState.mockReturnValue({ nodes: [] } as unknown as ReturnType<
      typeof useTreeStore.getState
    >);
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

  it("renders the phase timeline in the resolver's story-time order", async () => {
    const selected = makeEntry({ id: "hero", name: "Hero" });
    const nodes = [
      {
        id: "later-scene",
        projectId: "proj-1",
        parentId: null,
        nodeType: "scene",
        title: "Later scene",
        sortOrder: "a0",
        storyTimeOrder: "z0",
      },
      {
        id: "earlier-scene",
        projectId: "proj-1",
        parentId: null,
        nodeType: "scene",
        title: "Earlier scene",
        sortOrder: "a1",
        storyTimeOrder: "a0",
      },
    ] as TreeNodeData[];
    const phases: CodexEntryPhase[] = [
      {
        id: "later-phase",
        entryId: selected.id,
        anchorNodeId: "later-scene",
        label: "Later phase",
        summaryOverride: "later summary",
        contentOverride: null,
        contextModeOverride: null,
        version: 0,
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "earlier-phase",
        entryId: selected.id,
        anchorNodeId: "earlier-scene",
        label: "Earlier phase",
        summaryOverride: "earlier summary",
        contentOverride: null,
        contextModeOverride: null,
        version: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    mockListPhases.mockResolvedValue(phases);
    mockPhaseState.mockReturnValue({
      resolutionMode: "story",
      sceneTimeIndex: {
        readingOrder: new Map([
          ["later-scene", 0],
          ["earlier-scene", 1],
        ]),
        explicitStoryOrder: new Map([
          ["later-scene", "z0"],
          ["earlier-scene", "a0"],
        ]),
        inheritedStoryOrder: new Map([
          ["later-scene", "z0"],
          ["earlier-scene", "a0"],
        ]),
        liveSceneCount: 2,
        scheduledSceneCount: 2,
        revision: 1,
      },
    } as ReturnType<typeof usePhaseStore.getState>);
    mockTreeState.mockReturnValue({ nodes } as ReturnType<
      typeof useTreeStore.getState
    >);

    const result = await buildCodexScopeBlocks({
      selectedEntryId: selected.id,
      allEntries: [selected],
    });

    const fullContent = result?.selectedPinned.fullContent ?? "";
    expect(fullContent.indexOf("Earlier phase")).toBeGreaterThanOrEqual(0);
    expect(fullContent.indexOf("Later phase")).toBeGreaterThan(
      fullContent.indexOf("Earlier phase"),
    );
    expect(result?.selectedPinned.summary).toBe("later summary");
    expect(result?.selectedPinned.phaseLabel).toBe("Later phase");
  });
});
