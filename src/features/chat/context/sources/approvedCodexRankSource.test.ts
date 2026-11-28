import { describe, expect, it, vi } from "vitest";
const { approvedCodexReadMock } = vi.hoisted(() => ({
  approvedCodexReadMock: vi.fn(),
}));
vi.mock("../approvedCodexRankAvailability", () => ({
  CHAT_APPROVED_CODEX_RANK_ENABLED: true,
}));
vi.mock(
  "@/features/narrative-semantic-core/nir1EntityRelationRevisionApi",
  async (importOriginal) => ({
    ...(await importOriginal()),
    readApprovedNir1EntityRelationCodexEntryIds: approvedCodexReadMock,
  }),
);

import type { CodexContextEntry } from "@/features/codex/api";
import {
  collectNonSceneContext,
  createNonSceneContextSourceDeps,
} from "./nonSceneContextSource";
import {
  collectSceneContext,
  createSceneContextSourceDeps,
} from "./sceneContextSource";
import {
  createNonSceneTurnContextRequest,
  createSceneTurnContextRequest,
} from "../turnContextRequest";
import { buildSystemPrompt } from "../../contextBuilder";

const entries = Array.from({ length: 65 }, (_, index) => {
  const id = `entry-${String(index).padStart(2, "0")}`;
  return {
    id,
    projectId: "project-1",
    parentId: null,
    type: "character",
    name: id,
    aliases: null,
    excludedAliases: null,
    summary: `${id} summary`,
    content: `${id} body`,
    tagsCache: null,
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 0,
  } as CodexContextEntry;
});

const common = {
  requestId: "rank-source-test",
  purpose: "live" as const,
  projectId: "project-1",
  workspaceIdentity: { workspaceKey: "/workspace", workspaceOpenRevision: 1 },
  sessionId: null,
  mode: "chat" as const,
  route: null,
  budget: { contextWindow: 16_384, deliveryMode: "plain" as const },
  messages: [],
  outgoingUserMessage: "",
  mentionedSceneIds: [],
  mentionedCodexIds: entries.map(({ id }) => id),
  inputPinnedEntryIds: [],
  excludedAutoEntryIds: [],
  sessionStableCodexIds: [],
  includeBodies: true,
  map: { enabled: false, boardId: null, activeBoardId: null },
  activeTab: null,
  settings: {
    injectBeats: false,
    chronicleEnabled: false,
    semanticRecallEnabled: false,
    episodicRecallEnabled: false,
    hybridRecallEnabled: false,
    semanticRerankerMode: "off" as const,
    customChatInstruction: "",
  },
  trackRecallPromote: false,
};

function sceneRequest(sourceEntries = entries) {
  return createSceneTurnContextRequest({
    ...common,
    sceneId: "scene-1",
    sourceSnapshot: {
      scene: { id: "scene-1", title: "Scene", content: "Body" },
      project: { title: "Project", language: "en" },
      prefetchedCodexEntries: sourceEntries,
    },
  });
}

function nonSceneRequest() {
  return createNonSceneTurnContextRequest({
    ...common,
    scope: { kind: "project" },
    containerScope: "project",
    scopeAnchorId: null,
    activeSceneId: "scene-1",
    activeProjectId: "project-1",
    agentToolsAvailable: false,
    sourceSnapshot: { treeNodes: [], plotThreadIds: [], plotThreadLinks: [] },
  });
}

function expectReaderCandidates(): void {
  expect(approvedCodexReadMock).toHaveBeenCalledWith({
    expectedWorkspacePath: "/workspace",
    projectId: "project-1",
    codexEntryIds: entries.slice(0, 64).map(({ id }) => id),
  });
}

describe("approved Codex rank source reads", () => {
  it("passes the first 64 scene candidates and fails closed on reader rejection", async () => {
    approvedCodexReadMock.mockReset().mockResolvedValue({
      status: "available",
      approvedCodexEntryIds: [],
    });
    const request = sceneRequest();
    const deps = createSceneContextSourceDeps();
    const collected = await collectSceneContext(request, deps);
    expectReaderCandidates();
    expect(collected.promptInput.approvedCodexRanker).toBeUndefined();

    approvedCodexReadMock.mockRejectedValueOnce(new Error("reader failed"));
    const rejected = await collectSceneContext(request, deps);
    expect(rejected.promptInput.approvedCodexRanker).toBeUndefined();
  });

  it("passes the first 64 non-scene candidates and fails closed on reader rejection", async () => {
    approvedCodexReadMock.mockReset().mockResolvedValue({
      status: "available",
      approvedCodexEntryIds: [],
    });
    const request = nonSceneRequest();
    const deps = createNonSceneContextSourceDeps({
      fetchProjectContext: async () => ({ title: "Project", language: "en" }),
      listCodexEntries: async () => entries,
      listCodexContextMetadata: async () =>
        entries.map(({ content: _content, ...metadata }) => metadata),
      listCodexEntriesByIds: async (_projectId, ids) =>
        ids.flatMap((id) => entries.filter((entry) => entry.id === id)),
    });
    const collected = await collectNonSceneContext(request, deps);
    expectReaderCandidates();
    expect(collected.promptInput.approvedCodexRanker).toBeUndefined();

    approvedCodexReadMock.mockRejectedValueOnce(new Error("reader failed"));
    const rejected = await collectNonSceneContext(request, deps);
    expect(rejected.promptInput.approvedCodexRanker).toBeUndefined();
  });

  it.each(["scene", "non-scene"] as const)(
    "ranks the selected L4 items through the %s source and prompt builder",
    async (source) => {
      const rankingEntries = entries.slice(0, 3).map((entry) => ({
        ...entry,
        summary: "設定".repeat(120),
      }));
      const collect = async () => {
        approvedCodexReadMock.mockResolvedValueOnce({
          status: "available",
          approvedCodexEntryIds: [],
        });
        if (source === "scene") {
          return collectSceneContext(
            sceneRequest(rankingEntries),
            createSceneContextSourceDeps(),
          );
        }
        return collectNonSceneContext(
          nonSceneRequest(),
          createNonSceneContextSourceDeps({
            fetchProjectContext: async () => ({
              title: "Project",
              language: "en",
            }),
            listCodexEntries: async () => rankingEntries,
            listCodexContextMetadata: async () =>
              rankingEntries.map(
                ({ content: _content, ...metadata }) => metadata,
              ),
            listCodexEntriesByIds: async (_projectId, ids) =>
              ids.flatMap((id) =>
                rankingEntries.filter((entry) => entry.id === id),
              ),
          }),
        );
      };
      const initial = await collect();
      const input = {
        ...initial.promptInput,
        contextWindow: 1_200,
        outputReservationTokens: 100,
        conversationTokens: 0,
      };
      const baseline = buildSystemPrompt({
        ...input,
        approvedCodexRanker: undefined,
      });
      const baselineKeys = baseline.contextPlan!.items.map((item) => item.key);
      const approvedId = baselineKeys.at(-1)!.slice("codex:".length);

      approvedCodexReadMock.mockResolvedValueOnce({
        status: "available",
        approvedCodexEntryIds: [approvedId],
      });
      const rankedSource =
        source === "scene"
          ? await collectSceneContext(
              sceneRequest(rankingEntries),
              createSceneContextSourceDeps(),
            )
          : await collectNonSceneContext(
              nonSceneRequest(),
              createNonSceneContextSourceDeps({
                fetchProjectContext: async () => ({
                  title: "Project",
                  language: "en",
                }),
                listCodexEntries: async () => rankingEntries,
                listCodexContextMetadata: async () =>
                  rankingEntries.map(
                    ({ content: _content, ...metadata }) => metadata,
                  ),
                listCodexEntriesByIds: async (_projectId, ids) =>
                  ids.flatMap((id) =>
                    rankingEntries.filter((entry) => entry.id === id),
                  ),
              }),
            );
      const ranked = buildSystemPrompt({
        ...rankedSource.promptInput,
        contextWindow: 1_200,
        outputReservationTokens: 100,
        conversationTokens: 0,
      });
      const rankedKeys = ranked.contextPlan!.items.map((item) => item.key);

      expect(typeof rankedSource.promptInput.approvedCodexRanker).toBe(
        "function",
      );
      expect(baselineKeys.length).toBeGreaterThan(1);
      expect(new Set(rankedKeys)).toEqual(new Set(baselineKeys));
      expect(rankedKeys[0]).toBe(`codex:${approvedId}`);
      expect(rankedKeys).not.toEqual(baselineKeys);
      expect(ranked.totalTokens).toBe(baseline.totalTokens);
    },
  );
});
