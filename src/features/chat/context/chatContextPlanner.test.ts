import { describe, expect, it, vi } from "vitest";
import type { SceneContext } from "../contextBuilder";
import { createSceneTurnContextRequest } from "./turnContextRequest";
import { ContextPlanningError, planChatContext } from "./chatContextPlanner";
import { createContextPlannerDeps } from "./contextPlannerDeps";

function request(overrides: Record<string, unknown> = {}) {
  return createSceneTurnContextRequest({
    requestId: "request-1",
    purpose: "send",
    projectId: "project-1",
    sessionId: null,
    sceneId: "scene-1",
    mode: "chat",
    route: null,
    budget: {
      contextWindow: 16_384,
      maxOutputTokens: 2_048,
      responseReservationTokens: 1_024,
      deliveryMode: "plain",
    },
    messages: [],
    outgoingUserMessage: "hello",
    commandInstruction: undefined,
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
      customChatInstruction: "",
    },
    trackRecallPromote: false,
    sourceSnapshot: {
      scene: { id: "scene-1", title: "Scene", content: "Body" },
      project: { title: "Project", language: "en" },
    },
    ...overrides,
  });
}

describe("planChatContext", () => {
  it("plans a scene using only the request and injected source adapters", async () => {
    const collectScene = vi.fn(async () => ({
      scene: { id: "scene-1", title: "Scene", content: "Body" },
      project: { title: "Project", language: "en" },
      promptInput: {
        scene: { id: "scene-1", title: "Scene", content: "Body" },
        project: { title: "Project", language: "en" },
      },
      detectedEntries: [],
      alwaysEntries: [],
      stableCodexIds: [],
      projectOutline: undefined,
      chapterOutlines: [],
      recalledMessages: [],
    }));
    const deps = createContextPlannerDeps({
      ensureTokenizer: async () => {},
      collectRequiredSceneContext: collectScene,
      collectOptionalSceneContext: async () => ({}),
      renderPrompt: () => ({
        prompt: "exact prompt",
        totalTokens: 7,
        layers: [],
        cacheSegments: ["stable"],
        volatileTail: "tail",
      }),
    });

    const result = await planChatContext(request(), deps);

    expect(collectScene).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", sceneId: "scene-1" }),
    );
    expect(result.prompt).toBe("exact prompt");
    expect(result.cacheSegments).toEqual(["stable"]);
    expect(result.volatileTail).toBe("tail");
    expect(result.contextPlan.requestId).toBe("request-1");
    expect(result.diagnostics).toEqual([]);
  });

  it("reports an optional source failure without discarding the required scene", async () => {
    const scene: SceneContext = {
      id: "scene-1",
      title: "Scene",
      content: "Body",
    };
    const deps = createContextPlannerDeps({
      ensureTokenizer: async () => {},
      collectRequiredSceneContext: async () => ({
        scene,
        project: null,
        promptInput: { scene },
        detectedEntries: [],
        alwaysEntries: [],
        stableCodexIds: [],
        projectOutline: undefined,
        chapterOutlines: [],
        recalledMessages: [],
      }),
      collectOptionalSceneContext: async () => {
        throw new Error("map unavailable");
      },
      renderPrompt: () => ({ prompt: "ok", totalTokens: 1, layers: [] }),
    });

    const result = await planChatContext(request(), deps);

    expect(result.prompt).toBe("ok");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        source: "optional-scene-context",
        severity: "warning",
      }),
    ]);
  });

  it("turns a required scene failure into an explicit fatal planning error", async () => {
    const deps = createContextPlannerDeps({
      ensureTokenizer: async () => {},
      collectRequiredSceneContext: async () => {
        throw new Error("scene unavailable");
      },
      collectOptionalSceneContext: async () => ({}),
      renderPrompt: () => ({ prompt: "unused", totalTokens: 0, layers: [] }),
    });

    await expect(planChatContext(request(), deps)).rejects.toMatchObject({
      name: ContextPlanningError.name,
      diagnostics: [
        expect.objectContaining({ source: "scene", severity: "fatal" }),
      ],
    });
  });
});
