import { describe, expect, it, vi } from "vitest";
import { createNonSceneTurnContextRequest } from "./turnContextRequest";
import {
  planNonSceneChatContext,
  type NonSceneContextPlannerDeps,
} from "./nonSceneContextPlanner";
import type { NonSceneContextSourceDeps } from "./sources/nonSceneContextSource";

function request() {
  return createNonSceneTurnContextRequest({
    requestId: "non-scene-request",
    purpose: "live",
    projectId: "project-1",
    sessionId: null,
    scope: { kind: "project" },
    containerScope: "project",
    scopeAnchorId: null,
    activeSceneId: "scene-1",
    activeProjectId: "project-1",
    agentToolsAvailable: false,
    mode: "chat",
    route: null,
    budget: {
      contextWindow: 8_192,
      maxOutputTokens: 1_024,
      responseReservationTokens: 512,
      deliveryMode: "plain",
    },
    messages: [],
    outgoingUserMessage: "",
    mentionedSceneIds: [],
    mentionedCodexIds: [],
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
      customChatInstruction: "house style",
    },
    trackRecallPromote: false,
    sourceSnapshot: { treeNodes: [], plotThreadIds: [], plotThreadLinks: [] },
  });
}

describe("planNonSceneChatContext", () => {
  it("renders a collected non-scene context without reading global state", async () => {
    const collectContext = vi.fn(async () => ({
      promptInput: {
        scene: { id: "", title: "", content: "" },
        project: { title: "Project", language: "en" },
      },
      detectedEntries: [],
      alwaysEntries: [],
      scopeAnchor: null,
      projectOutline: "Outline",
      chapterOutlines: [],
    }));
    const renderPrompt = vi.fn(() => ({
      prompt: "rendered",
      totalTokens: 9,
      layers: [],
      cacheSegments: ["stable"],
      volatileTail: "volatile",
    }));
    const deps: NonSceneContextPlannerDeps = {
      ensureTokenizer: async () => {},
      collectContext,
      source: {} as NonSceneContextSourceDeps,
      renderPrompt,
    };

    const result = await planNonSceneChatContext(request(), deps);

    expect(collectContext).toHaveBeenCalledWith(request(), deps.source);
    expect(renderPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        contextRequestId: "non-scene-request",
        contextWindow: 8_192,
        maxOutputTokens: 1_024,
        outputReservationTokens: 512,
        customChatInstruction: "house style",
      }),
    );
    expect(result.prompt).toBe("rendered");
    expect(result.cacheSegments).toEqual(["stable"]);
    expect(result.volatileTail).toBe("volatile");
    expect(result.contextPlan.requestId).toBe("non-scene-request");
    expect(result.projectOutline).toBe("Outline");
  });
});
