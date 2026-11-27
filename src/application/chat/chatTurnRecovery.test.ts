import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/features/chat/chatTypes";
import type { ChatTurnRuntime } from "./chatTurnRuntime";
import type { ChatState } from "./chatStoreTypes";
import { createTurnRecovery } from "./chatTurnRecovery";

describe("createTurnRecovery", () => {
  it("persists the captured completed turn and retains its retry callback", async () => {
    const userMessage = {
      id: "user-1",
      sessionId: "session-1",
      role: "user",
      content: "hello",
      createdAt: "1",
    } as ChatMessage;
    const assistantMessage = {
      id: "assistant-1",
      sessionId: "session-1",
      role: "assistant",
      content: "answer",
      createdAt: "2",
    } as ChatMessage;
    let persistenceInput:
      | Parameters<ChatTurnRuntime["persistCompletedTurn"]>[0]
      | undefined;
    const persistCompletedTurn = vi.fn(async (input) => {
      persistenceInput = input;
    });
    const recovery = createTurnRecovery({
      runtime: {
        persistCompletedTurn,
      } as unknown as ChatTurnRuntime,
      turnId: "turn-1",
      workspaceIdentity: null,
      projectId: "project-1",
      userMessage,
      content: "hello",
      chatApi: {
        getSessionForProject: vi.fn(),
        addMessage: vi.fn(),
        saveMessagePrompt: vi.fn(),
      },
      get: () => ({ sessions: [] }) as unknown as ChatState,
      getSessionId: () => "session-1",
      isCapturedWorkspaceCurrent: () => true,
      isCapturedProjectCurrent: () => true,
      isCurrentTurn: () => true,
      isAborted: () => false,
      transportStarted: () => false,
      isAgentPath: false,
      transport: "http",
      chatScope: "project",
      scopeAnchorId: null,
      assistantMessage,
      getObservedResponseText: () => "",
      model: "model-1",
      routeModel: undefined,
      isAiFeatureBlockedByPolicy: () => false,
      isWriteRestrictedByLicense: () => false,
      classifyError: () => "unknown",
      aiFailureToastText: () => "failed",
      toast: { error: vi.fn(), warning: vi.fn() },
      i18next: { t: (key) => key },
      debugLog: { error: vi.fn() },
      errorDetail: String,
    });
    const retry = vi.fn(async () => {});

    await recovery.persistCompletedTurn({
      retry,
      sessionId: "session-1",
      userMetadata: "mentioned",
      assistantMessage,
    });
    await persistenceInput?.retry();

    expect(persistCompletedTurn).toHaveBeenCalledOnce();
    expect(persistenceInput).toMatchObject({
      turnId: "turn-1",
      projectId: "project-1",
      sessionId: "session-1",
      userMessage: {
        id: "user-1",
        content: "hello",
        metadata: "mentioned",
      },
      assistantMessage: {
        id: "assistant-1",
        content: "answer",
        sessionId: "session-1",
      },
    });
    expect(retry).toHaveBeenCalledOnce();
  });
});
