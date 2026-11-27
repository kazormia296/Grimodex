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

function sceneRequest() {
  return createSceneTurnContextRequest({
    ...common,
    sceneId: "scene-1",
    sourceSnapshot: {
      scene: { id: "scene-1", title: "Scene", content: "Body" },
      project: { title: "Project", language: "en" },
      prefetchedCodexEntries: entries,
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
    expect(collected.promptInput.approvedCodexEntryIds).toEqual(new Set());

    approvedCodexReadMock.mockRejectedValueOnce(new Error("reader failed"));
    const rejected = await collectSceneContext(request, deps);
    expect(rejected.promptInput.approvedCodexEntryIds).toBeUndefined();
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
    expect(collected.promptInput.approvedCodexEntryIds).toEqual(new Set());

    approvedCodexReadMock.mockRejectedValueOnce(new Error("reader failed"));
    const rejected = await collectNonSceneContext(request, deps);
    expect(rejected.promptInput.approvedCodexEntryIds).toBeUndefined();
  });
});
