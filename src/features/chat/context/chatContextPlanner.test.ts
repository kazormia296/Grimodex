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
      semanticRerankerMode: "off",
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
      diagnostics: [],
    }));
    const renderPrompt = vi.fn(() => ({
      prompt: "exact prompt",
      totalTokens: 7,
      layers: [],
      cacheSegments: ["stable"],
      volatileTail: "tail",
    }));
    const deps = createContextPlannerDeps({
      ensureTokenizer: async () => {},
      collectRequiredSceneContext: collectScene,
      collectOptionalSceneContext: async () => ({}),
      renderPrompt,
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
    expect(renderPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ tokenCountingMode: "exact" }),
    );
  });

  it("uses the cheap token estimator only for the live UI cache", async () => {
    const renderPrompt = vi.fn(() => ({
      prompt: "live prompt",
      totalTokens: 7,
      layers: [],
    }));
    const deps = createContextPlannerDeps({
      ensureTokenizer: async () => {},
      collectRequiredSceneContext: async () => ({
        scene: { id: "scene-1", title: "Scene", content: "Body" },
        project: { title: "Project", language: "en" },
        promptInput: {
          scene: { id: "scene-1", title: "Scene", content: "Body" },
        },
        detectedEntries: [],
        alwaysEntries: [],
        stableCodexIds: [],
        projectOutline: undefined,
        chapterOutlines: [],
        recalledMessages: [],
        diagnostics: [],
      }),
      renderPrompt,
    });

    await planChatContext(request({ purpose: "live" }), deps);

    expect(renderPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ tokenCountingMode: "live-estimate" }),
    );
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
        diagnostics: [],
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
        code: "OPTIONAL_SCENE_CONTEXT_UNAVAILABLE",
        message:
          "Optional scene context is unavailable; continuing without it.",
      }),
    ]);
    expect(result.contextPlan.decisions).toEqual([
      {
        key: "source:optional-scene-context:OPTIONAL_SCENE_CONTEXT_UNAVAILABLE",
        status: "unavailable",
        reason: "optional-scene-context-unavailable",
        tokensBefore: 0,
        tokensAfter: 0,
      },
    ]);
  });

  it("preserves structured source diagnostics without changing rendered prompt bytes", async () => {
    const sourceDiagnostics = [
      {
        source: "pinned-snippets",
        severity: "warning" as const,
        code: "PINNED_SNIPPETS_UNAVAILABLE",
        message: "Pinned snippets are unavailable; continuing without them.",
      },
      {
        source: "semantic-recall",
        severity: "warning" as const,
        code: "SEMANTIC_RECALL_UNAVAILABLE",
        message: "Semantic recall is unavailable; continuing without it.",
      },
    ];
    const deps = createContextPlannerDeps({
      collectRequiredSceneContext: async () => ({
        scene: { id: "scene-1", title: "Scene", content: "Body" },
        project: { title: "Project", language: "en" },
        promptInput: {
          scene: { id: "scene-1", title: "Scene", content: "Body" },
        },
        detectedEntries: [],
        alwaysEntries: [],
        stableCodexIds: [],
        projectOutline: undefined,
        chapterOutlines: [],
        recalledMessages: [],
        diagnostics: sourceDiagnostics,
      }),
      renderPrompt: () => ({
        prompt: "byte-identical prompt",
        totalTokens: 3,
        layers: [],
      }),
    });

    const result = await planChatContext(request(), deps);

    expect(result.prompt).toBe("byte-identical prompt");
    expect(result.diagnostics).toEqual(sourceDiagnostics);
    expect(result.contextPlan.decisions).toEqual([
      {
        key: "source:pinned-snippets:PINNED_SNIPPETS_UNAVAILABLE",
        status: "unavailable",
        reason: "pinned-snippets-unavailable",
        tokensBefore: 0,
        tokensAfter: 0,
      },
      {
        key: "source:semantic-recall:SEMANTIC_RECALL_UNAVAILABLE",
        status: "unavailable",
        reason: "semantic-recall-unavailable",
        tokensBefore: 0,
        tokensAfter: 0,
      },
    ]);
  });

  it("keeps diagnostic decisions and their digest stable across completion order and runtime metadata", async () => {
    const makeDeps = (
      diagnostics: Array<{
        source: string;
        severity: "warning";
        code: string;
        message: string;
        latencyMs?: number;
        cause?: unknown;
      }>,
    ) =>
      createContextPlannerDeps({
        collectRequiredSceneContext: async () => ({
          scene: { id: "scene-1", title: "Scene", content: "Body" },
          project: { title: "Project", language: "en" },
          promptInput: {
            scene: { id: "scene-1", title: "Scene", content: "Body" },
          },
          detectedEntries: [],
          alwaysEntries: [],
          stableCodexIds: [],
          projectOutline: undefined,
          chapterOutlines: [],
          recalledMessages: [],
          diagnostics,
        }),
        renderPrompt: () => ({
          prompt: "byte-identical prompt",
          totalTokens: 3,
          layers: [],
        }),
      });
    const first = await planChatContext(
      request(),
      makeDeps([
        {
          source: "semantic-recall",
          severity: "warning",
          code: "SEMANTIC_RECALL_UNAVAILABLE",
          message: "first runtime message",
          latencyMs: 21,
          cause: new Error("first runtime error"),
        },
        {
          source: "pinned-snippets",
          severity: "warning",
          code: "PINNED_SNIPPETS_UNAVAILABLE",
          message: "first snippet message",
        },
      ]),
    );
    const second = await planChatContext(
      request(),
      makeDeps([
        {
          source: "pinned-snippets",
          severity: "warning",
          code: "PINNED_SNIPPETS_UNAVAILABLE",
          message: "second snippet message",
          latencyMs: 8,
        },
        {
          source: "semantic-recall",
          severity: "warning",
          code: "SEMANTIC_RECALL_UNAVAILABLE",
          message: "second runtime message",
          latencyMs: 89,
          cause: new Error("second runtime error"),
        },
      ]),
    );

    expect(first.prompt).toBe("byte-identical prompt");
    expect(second.prompt).toBe(first.prompt);
    expect(second.contextPlan.decisions).toEqual(first.contextPlan.decisions);
    expect(second.contextPlan.digest).toBe(first.contextPlan.digest);
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
        expect.objectContaining({
          source: "scene",
          severity: "fatal",
          code: "REQUIRED_SCENE_CONTEXT_UNAVAILABLE",
        }),
      ],
    });
  });
});
