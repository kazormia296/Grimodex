import { describe, expect, it } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { ResolvedChatTurnRoute } from "../turn/resolveTurnRoute";
import {
  createNonSceneTurnContextRequest,
  createSceneTurnContextRequest,
} from "./turnContextRequest";

describe("createSceneTurnContextRequest", () => {
  it("copies mutable turn inputs into an immutable scene snapshot", () => {
    const messages = [
      {
        id: "m1",
        sessionId: "session-1",
        role: "user" as const,
        content: "hello",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const mentionedSceneIds = ["scene-2"];
    const request = createSceneTurnContextRequest({
      requestId: "request-1",
      purpose: "send",
      projectId: "project-1",
      sessionId: "session-1",
      sceneId: "scene-1",
      mode: "chat",
      route: null,
      budget: {
        contextWindow: 16_384,
        maxOutputTokens: 2_048,
        responseReservationTokens: 1_024,
        deliveryMode: "plain",
      },
      messages,
      outgoingUserMessage: "next",
      commandInstruction: undefined,
      mentionedSceneIds,
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
        semanticRecallEnabled: true,
        episodicRecallEnabled: true,
        hybridRecallEnabled: true,
        semanticRerankerMode: "apply",
        customChatInstruction: "",
      },
      trackRecallPromote: true,
      sourceSnapshot: {
        scene: { id: "scene-1", title: "Scene", content: "Body" },
        project: { title: "Project", language: "en" },
      },
    });

    messages[0].content = "mutated";
    mentionedSceneIds.push("scene-3");

    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.content).toBe("hello");
    expect(request.mentionedSceneIds).toEqual(["scene-2"]);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.messages)).toBe(true);
  });

  it("deep-snapshots nested route capability objects", () => {
    const route = {
      capabilities: { contextWindow: 16_384 },
      outputBudget: { responseReservationTokens: 1_024 },
    } as unknown as ResolvedChatTurnRoute;
    const request = createSceneTurnContextRequest({
      requestId: "request-route",
      purpose: "send",
      projectId: "project-1",
      sessionId: null,
      sceneId: "scene-1",
      mode: "chat",
      route,
      budget: { contextWindow: 16_384, deliveryMode: "plain" },
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
        injectBeats: true,
        chronicleEnabled: true,
        semanticRecallEnabled: true,
        episodicRecallEnabled: true,
        hybridRecallEnabled: true,
        semanticRerankerMode: "shadow",
        customChatInstruction: "",
      },
      trackRecallPromote: false,
      sourceSnapshot: {
        scene: { id: "scene-1", title: "Scene", content: "Body" },
        project: { title: "Project", language: "en" },
      },
    });

    route.capabilities.contextWindow = 8_000;

    expect(request.route?.capabilities.contextWindow).toBe(16_384);
    expect(Object.isFrozen(request.route?.capabilities)).toBe(true);
  });
});

describe("createNonSceneTurnContextRequest", () => {
  it("deeply snapshots tree and thread membership with the selected scope", () => {
    const treeNodes: TreeNodeData[] = [
      {
        id: "scene-1",
        projectId: "project-1",
        parentId: null,
        nodeType: "scene",
        title: "Original",
        synopsis: null,
        intent: null,
        sortOrder: "a0",
        status: null,
        storyTimeOrder: null,
        storyTimeLabel: null,
        povCharacterId: null,
        locationId: null,
        charCount: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const plotThreadLinks = [{ threadId: "thread-1", nodeId: "scene-1" }];
    const request = createNonSceneTurnContextRequest({
      requestId: "request-2",
      purpose: "live",
      projectId: "project-1",
      sessionId: null,
      scope: { kind: "thread", threadId: "thread-1", title: "Thread" },
      containerScope: "project",
      scopeAnchorId: null,
      activeSceneId: "scene-1",
      activeProjectId: "project-1",
      agentToolsAvailable: false,
      mode: "chat",
      route: null,
      budget: { contextWindow: 16_384, deliveryMode: "plain" },
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
        semanticRerankerMode: "off",
        customChatInstruction: "",
      },
      trackRecallPromote: false,
      sourceSnapshot: {
        treeNodes,
        plotThreadIds: ["thread-1"],
        plotThreadLinks,
      },
    });

    treeNodes[0]!.title = "Mutated";
    plotThreadLinks[0]!.nodeId = "scene-2";

    expect(request.sourceSnapshot.treeNodes[0]?.title).toBe("Original");
    expect(request.sourceSnapshot.plotThreadLinks[0]?.nodeId).toBe("scene-1");
    expect(Object.isFrozen(request.sourceSnapshot.treeNodes[0])).toBe(true);
  });
});
