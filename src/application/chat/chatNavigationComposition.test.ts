import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetChatNavigationGuardForTests,
  isChatSceneTransitionBlocked,
} from "@/lib/chatNavigationGuard";
import {
  publishSceneAuthorityCommit,
  registerSceneAuthorityCommitSink,
} from "@/application/tree/sceneAuthorityRegistry";
import { installChatNavigationBlockers } from "./chatNavigationComposition";
import { getActiveTurnStopper } from "@/lib/activeTurnStopRegistry";

afterEach(() => {
  __resetChatNavigationGuardForTests();
  registerSceneAuthorityCommitSink(null);
});

describe("installChatNavigationBlockers", () => {
  it("registers the generating turn for the close and switch confirmation", () => {
    const stopGeneration = vi.fn();
    installChatNavigationBlockers({
      getState: () => ({
        agentMode: false,
        isStreaming: true,
        setActiveSceneId: vi.fn(),
        stopGeneration,
      }),
      hasPendingPersistence: () => false,
      activeTurnSurface: () => "chat",
    });

    expect(getActiveTurnStopper()?.isActive()).toBe(true);
    getActiveTurnStopper()?.stop();
    expect(stopGeneration).toHaveBeenCalledOnce();
  });

  it("uses the accepted turn surface when Agent is an override", () => {
    installChatNavigationBlockers({
      getState: () => ({
        agentMode: false,
        isStreaming: true,
        setActiveSceneId: vi.fn(),
        stopGeneration: vi.fn(),
      }),
      hasPendingPersistence: () => false,
      activeTurnSurface: () => "agent",
    });

    expect(isChatSceneTransitionBlocked()).toBe(true);
  });

  it("does not overblock an accepted normal turn when Agent mode was overridden off", () => {
    installChatNavigationBlockers({
      getState: () => ({
        agentMode: true,
        isStreaming: true,
        setActiveSceneId: vi.fn(),
        stopGeneration: vi.fn(),
      }),
      hasPendingPersistence: () => false,
      activeTurnSurface: () => "chat",
    });

    expect(isChatSceneTransitionBlocked()).toBe(false);
  });

  it("installs the synchronous Tree to Chat authority mirror", () => {
    const setActiveSceneId = vi.fn();
    installChatNavigationBlockers({
      getState: () => ({
        agentMode: false,
        isStreaming: false,
        setActiveSceneId,
        stopGeneration: vi.fn(),
      }),
      hasPendingPersistence: () => false,
      activeTurnSurface: () => null,
    });

    publishSceneAuthorityCommit("scene-2");

    expect(setActiveSceneId).toHaveBeenCalledWith("scene-2");
  });
});
