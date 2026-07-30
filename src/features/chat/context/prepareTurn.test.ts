import { describe, expect, it, vi } from "vitest";

import {
  createNonSceneTurnContextRequest,
  createSceneTurnContextRequest,
  prepareTurn,
} from "./prepareTurn";
import type { ChatContextPlanResult } from "./chatContextPlanner";
import type { NonSceneContextPlanResult } from "./nonSceneContextPlanner";
import type { ChatScope } from "../chatScope";
import type { ContextScopeTarget } from "./turnContextRequest";

function sceneRequest() {
  return createSceneTurnContextRequest({
    requestId: "scene-request",
    purpose: "send",
    projectId: "project-a",
    sessionId: "session-a",
    sceneId: "scene-a",
    mode: "chat",
    route: null,
    budget: { contextWindow: 16_384, deliveryMode: "plain" },
    messages: [],
    outgoingUserMessage: "hello",
    mentionedSceneIds: [],
    mentionedCodexIds: [],
    inputPinnedEntryIds: [],
    excludedAutoEntryIds: [],
    sessionStableCodexIds: [],
    includeBodies: true,
    map: { enabled: false, boardId: null, activeBoardId: null },
    activeTab: null,
    settings: {
      injectBeats: true,
      chronicleEnabled: true,
      semanticRecallEnabled: false,
      episodicRecallEnabled: false,
      hybridRecallEnabled: false,
      semanticRerankerMode: "off",
      customChatInstruction: "",
    },
    trackRecallPromote: false,
    sourceSnapshot: {
      scene: { id: "scene-a", title: "Scene", content: "Body" },
      project: null,
    },
  });
}

function nonSceneRequest(input: {
  scope: Exclude<ContextScopeTarget, { kind: "scene" }>;
  containerScope: ChatScope;
  scopeAnchorId: string | null;
}) {
  return createNonSceneTurnContextRequest({
    requestId: "project-request",
    purpose: "send",
    projectId: "project-a",
    sessionId: "session-a",
    mode: "chat",
    route: null,
    budget: { contextWindow: 16_384, deliveryMode: "plain" },
    messages: [],
    outgoingUserMessage: "hello",
    mentionedSceneIds: [],
    mentionedCodexIds: [],
    inputPinnedEntryIds: [],
    excludedAutoEntryIds: [],
    sessionStableCodexIds: [],
    includeBodies: false,
    map: { enabled: false, boardId: null, activeBoardId: null },
    activeTab: null,
    settings: {
      injectBeats: true,
      chronicleEnabled: true,
      semanticRecallEnabled: false,
      episodicRecallEnabled: false,
      hybridRecallEnabled: false,
      semanticRerankerMode: "off",
      customChatInstruction: "",
    },
    trackRecallPromote: false,
    scope: input.scope,
    containerScope: input.containerScope,
    scopeAnchorId: input.scopeAnchorId,
    activeSceneId: "scene-a",
    activeProjectId: "project-a",
    agentToolsAvailable: false,
    sourceSnapshot: {
      treeNodes: [],
      plotThreadIds: [],
      plotThreadLinks: [],
    },
  });
}

describe("prepareTurn", () => {
  it("routes scene requests through the scene planner", async () => {
    const planScene = vi.fn(async () => ({}) as ChatContextPlanResult);
    const request = sceneRequest();

    await prepareTurn(
      request,
      { scene: {} as never },
      {
        planScene,
        planNonScene: vi.fn(async () => ({}) as NonSceneContextPlanResult),
      },
    );

    expect(planScene).toHaveBeenCalledWith(request, expect.anything());
  });

  it.each([
    {
      label: "global",
      scope: { kind: "global" } as const,
      containerScope: "scene" as const,
      scopeAnchorId: null,
    },
    {
      label: "folder",
      scope: { kind: "folder", folderId: "folder-a" } as const,
      containerScope: "folder" as const,
      scopeAnchorId: "folder-a",
    },
    {
      label: "project",
      scope: { kind: "project" } as const,
      containerScope: "project" as const,
      scopeAnchorId: null,
    },
    {
      label: "codex",
      scope: { kind: "codex", entryId: "codex-a" } as const,
      containerScope: "codex" as const,
      scopeAnchorId: "codex-a",
    },
    {
      label: "snippet",
      scope: { kind: "snippet", snippetId: "snippet-a" } as const,
      containerScope: "snippet" as const,
      scopeAnchorId: "snippet-a",
    },
    {
      label: "thread",
      scope: {
        kind: "thread",
        threadId: "thread-a",
        title: "Thread A",
      } as const,
      containerScope: "folder" as const,
      scopeAnchorId: "folder-a",
    },
  ])(
    "routes $label through the non-scene planner without changing container identity",
    async ({ scope, containerScope, scopeAnchorId }) => {
      const planNonScene = vi.fn(async () => ({}) as NonSceneContextPlanResult);
      const request = nonSceneRequest({
        scope,
        containerScope,
        scopeAnchorId,
      });

      await prepareTurn(
        request,
        { nonScene: {} as never },
        {
          planScene: vi.fn(async () => ({}) as ChatContextPlanResult),
          planNonScene,
        },
      );

      expect(planNonScene).toHaveBeenCalledWith(request, expect.anything());
      expect(request.containerScope).toBe(containerScope);
      expect(request.scopeAnchorId).toBe(scopeAnchorId);
    },
  );
});
