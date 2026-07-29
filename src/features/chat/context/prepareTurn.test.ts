import { describe, expect, it, vi } from "vitest";

import {
  createNonSceneTurnContextRequest,
  createSceneTurnContextRequest,
  prepareTurn,
} from "./prepareTurn";
import type { ChatContextPlanResult } from "./chatContextPlanner";
import type { NonSceneContextPlanResult } from "./nonSceneContextPlanner";

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
      customChatInstruction: "",
    },
    trackRecallPromote: false,
    sourceSnapshot: {
      scene: { id: "scene-a", title: "Scene", content: "Body" },
      project: null,
    },
  });
}

function nonSceneRequest() {
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
      customChatInstruction: "",
    },
    trackRecallPromote: false,
    scope: { kind: "global" },
    containerScope: "project",
    scopeAnchorId: null,
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

  it("routes every non-scene scope through the non-scene planner", async () => {
    const planNonScene = vi.fn(async () => ({}) as NonSceneContextPlanResult);
    const request = nonSceneRequest();

    await prepareTurn(
      request,
      { nonScene: {} as never },
      {
        planScene: vi.fn(async () => ({}) as ChatContextPlanResult),
        planNonScene,
      },
    );

    expect(planNonScene).toHaveBeenCalledWith(request, expect.anything());
  });
});
