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

afterEach(() => {
  __resetChatNavigationGuardForTests();
  registerSceneAuthorityCommitSink(null);
});

describe("installChatNavigationBlockers", () => {
  it("uses the accepted turn surface when Agent is an override", () => {
    installChatNavigationBlockers({
      getState: () => ({
        agentMode: false,
        isStreaming: true,
        setActiveSceneId: vi.fn(),
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
      }),
      hasPendingPersistence: () => false,
      activeTurnSurface: () => null,
    });

    publishSceneAuthorityCommit("scene-2");

    expect(setActiveSceneId).toHaveBeenCalledWith("scene-2");
  });
});
