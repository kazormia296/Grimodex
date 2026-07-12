import { beforeEach, describe, expect, it, vi } from "vitest";

const chatHarness = vi.hoisted(() => {
  const events: string[] = [];
  const state = {
    isStreaming: true,
    stopGeneration: vi.fn(() => {
      events.push("stop");
    }),
  };
  const setState = vi.fn((patch: Record<string, unknown>) => {
    events.push("reset");
    Object.assign(state, patch);
  });
  const useChatStore = Object.assign(
    vi.fn((selector?: (value: typeof state) => unknown) =>
      selector ? selector(state) : state,
    ),
    {
      getState: vi.fn(() => state),
      setState,
    },
  );

  return { events, state, setState, useChatStore };
});

const phaseHarness = vi.hoisted(() => {
  const resetForProject = vi.fn();
  const state = {
    projectEpoch: 4,
    phasesByEntry: {
      sharedEntryId: [{ id: "old-project-phase" }],
    } as Record<string, unknown[]>,
    detailOverrides: {
      "old-project-phase": [{ id: "old-override" }],
    } as Record<string, unknown[]>,
    globalSceneOrder: new Map([["sharedSceneId", 3]]),
    sceneTimeIndex: {
      readingOrder: new Map([["sharedSceneId", 3]]),
      explicitStoryOrder: new Map([["sharedSceneId", "a0"]]),
      inheritedStoryOrder: new Map([["sharedSceneId", "a0"]]),
      liveSceneCount: 1,
      scheduledSceneCount: 1,
      revision: 7,
    },
    resolvedStates: {
      sharedEntryId: { summary: "old project value" },
    } as Record<string, unknown>,
    resolutionMode: "story" as const,
    cachedNodes: [{ id: "sharedSceneId" }],
    resetForProject,
  };
  resetForProject.mockImplementation(() => {
    state.projectEpoch += 1;
    state.phasesByEntry = {};
    state.detailOverrides = {};
    state.globalSceneOrder = new Map();
    state.sceneTimeIndex = {
      readingOrder: new Map(),
      explicitStoryOrder: new Map(),
      inheritedStoryOrder: new Map(),
      liveSceneCount: 0,
      scheduledSceneCount: 0,
      revision: state.sceneTimeIndex.revision + 1,
    };
    state.resolvedStates = {};
    state.cachedNodes = [];
  });
  const setState = vi.fn((patch: Record<string, unknown>) => {
    Object.assign(state, patch);
  });
  const usePhaseStore = Object.assign(vi.fn(), {
    getState: vi.fn(() => state),
    setState,
  });

  return { state, resetForProject, setState, usePhaseStore };
});

vi.mock("@/features/chat/chatStore", () => ({
  useChatStore: chatHarness.useChatStore,
}));

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: phaseHarness.usePhaseStore,
}));

import {
  resetChatForProject,
  resetPhaseStateForProject,
} from "./reloadProjectData";

describe("resetChatForProject", () => {
  beforeEach(() => {
    chatHarness.events.length = 0;
    chatHarness.state.isStreaming = true;
    chatHarness.state.stopGeneration.mockClear();
    chatHarness.setState.mockClear();
  });

  it("aborts the old turn before resetting project-scoped chat state", () => {
    resetChatForProject("project-b");

    expect(chatHarness.events.slice(0, 2)).toEqual(["stop", "reset"]);
    expect(chatHarness.state.stopGeneration).toHaveBeenCalledOnce();
    expect(chatHarness.setState).toHaveBeenCalledOnce();
    expect(chatHarness.setState.mock.calls[0]?.[0]).toMatchObject({
      activeSessionId: null,
      isLoadingSessions: false,
      isLoadingMessages: false,
      sessions: [],
      messages: [],
      isStreaming: false,
      activeProjectId: "project-b",
      activeSceneId: "",
      contextTokenCount: 0,
      contextWindowSize: null,
      contextLayers: [],
      contextPlan: null,
      lastSystemPrompt: "",
      lastSystemPromptKey: null,
      projectOutline: undefined,
      chapterOutlines: [],
      detectedEntries: [],
      alwaysEntries: [],
      scopeAnchor: null,
      threadFocusOverride: null,
      excludedAutoEntryIds: [],
      inputPinnedEntryIds: [],
      agentProgress: null,
      subAgentProgress: null,
      agentContinuation: null,
      pendingUserQuestion: null,
      chatScope: "scene",
      scopeAnchorId: null,
      includeBodies: true,
      includeMapBoard: false,
      mapBoardId: null,
      summaryCount: 0,
      maxSummaryGeneration: 0,
      sessionStableCodexIds: [],
      sessionAgentToolsSnapshot: null,
    });
  });

  it("does not issue an abort when no generation is active", () => {
    chatHarness.state.isStreaming = false;

    resetChatForProject("project-c");

    expect(chatHarness.state.stopGeneration).not.toHaveBeenCalled();
    expect(chatHarness.events).toEqual(["reset"]);
  });
});

describe("resetPhaseStateForProject", () => {
  beforeEach(() => {
    phaseHarness.state.projectEpoch = 4;
    phaseHarness.state.phasesByEntry = {
      sharedEntryId: [{ id: "old-project-phase" }],
    };
    phaseHarness.state.detailOverrides = {
      "old-project-phase": [{ id: "old-override" }],
    };
    phaseHarness.state.globalSceneOrder = new Map([["sharedSceneId", 3]]);
    phaseHarness.state.sceneTimeIndex = {
      readingOrder: new Map([["sharedSceneId", 3]]),
      explicitStoryOrder: new Map([["sharedSceneId", "a0"]]),
      inheritedStoryOrder: new Map([["sharedSceneId", "a0"]]),
      liveSceneCount: 1,
      scheduledSceneCount: 1,
      revision: 7,
    };
    phaseHarness.state.resolvedStates = {
      sharedEntryId: { summary: "old project value" },
    };
    phaseHarness.state.resolutionMode = "story";
    phaseHarness.state.cachedNodes = [{ id: "sharedSceneId" }];
    phaseHarness.resetForProject.mockClear();
    phaseHarness.setState.mockClear();
  });

  it("clears same-id caches while preserving the newly applied mode", () => {
    resetPhaseStateForProject();

    expect(phaseHarness.state.phasesByEntry).toEqual({});
    expect(phaseHarness.state.detailOverrides).toEqual({});
    expect(phaseHarness.state.resolvedStates).toEqual({});
    expect(phaseHarness.state.globalSceneOrder.size).toBe(0);
    expect(phaseHarness.state.sceneTimeIndex.readingOrder.size).toBe(0);
    expect(phaseHarness.state.sceneTimeIndex.revision).toBe(8);
    expect(phaseHarness.state.cachedNodes).toEqual([]);
    expect(phaseHarness.state.resolutionMode).toBe("story");
    expect(phaseHarness.state.projectEpoch).toBe(5);
    expect(phaseHarness.resetForProject).toHaveBeenCalledOnce();
  });
});
