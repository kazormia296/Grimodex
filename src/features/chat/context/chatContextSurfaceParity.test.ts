import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerChatContextPreparation,
  type ChatContextPreparationInput,
  type PreparedChatContext,
} from "@/application/chat/chatContextPreparation";
import { useChatStore } from "../chatStore";

function prepared(
  input: ChatContextPreparationInput,
  recalledMessages: PreparedChatContext["recalledMessages"] = [],
): PreparedChatContext {
  return {
    privacy: input.privacy,
    prompt: "prepared prompt",
    totalTokens: 7,
    layers: [],
    contextPlan: {
      requestId: input.requestId,
      items: [],
      decisions: [],
      usage: {
        candidateTokens: 0,
        selectedTokens: 0,
        trimmedTokens: 0,
        budgetTokens: null,
      },
      digest: "surface-parity",
    },
    detectedEntries: [],
    alwaysEntries: [],
    fullyInjectedIds: [],
    stableContextIds: [],
    recalledMessages,
    scopeAnchor: null,
    projectOutline: undefined,
    chapterOutlines: [],
    authority: { chronicleRevision: 1 },
  };
}

let restoreRegistration: (() => void) | null = null;

beforeEach(() => {
  useChatStore.getState().resetForProject("project-1");
  useChatStore.setState({
    activeProjectId: "project-1",
    activeSceneId: "scene-1",
    chatScope: "scene",
    messages: [],
  });
});

afterEach(() => {
  restoreRegistration?.();
  restoreRegistration = null;
});

describe("Chat context surface parity", () => {
  it("projects every private surface onto the same preparation semantics", async () => {
    const prepare = vi.fn(async (input: ChatContextPreparationInput) =>
      prepared(input),
    );
    restoreRegistration = registerChatContextPreparation({
      prepare,
      isAuthorityCurrent: () => true,
    });
    const message = {
      id: "message-1",
      sessionId: "",
      role: "user" as const,
      content: "same input",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const surfaces = [
      { purpose: "live", agentModeOverride: false },
      { purpose: "preview", agentModeOverride: false },
      { purpose: "copy", agentModeOverride: false },
      { purpose: "send", agentModeOverride: false },
      { purpose: "send", agentModeOverride: true },
    ] as const;

    for (const surface of surfaces) {
      await useChatStore.getState().refreshContextLayers({
        ...surface,
        privacy: "private",
        conversationMessages: [message],
        outgoingUserMessage: "same input",
        mentionedSceneIds: ["scene-2"],
        mentionedCodexIds: ["codex-1"],
        strict: true,
      });
    }

    expect(prepare).toHaveBeenCalledTimes(5);
    expect(
      prepare.mock.calls.map(([input]) => ({
        projectId: input.projectId,
        sceneId: input.effectiveSceneId,
        scope: input.chatScope,
        outgoing: input.outgoingUserMessage,
        messages: input.messages.map((entry) => ({
          role: entry.role,
          content: entry.content,
        })),
        mentionedSceneIds: input.mentionedSceneIds,
        mentionedCodexIds: input.mentionedCodexIds,
        privacy: input.privacy,
      })),
    ).toEqual(
      Array.from({ length: 5 }, () => ({
        projectId: "project-1",
        sceneId: "scene-1",
        scope: "scene",
        outgoing: "same input",
        messages: [{ role: "user", content: "same input" }],
        mentionedSceneIds: ["scene-2"],
        mentionedCodexIds: ["codex-1"],
        privacy: "private",
      })),
    );
    expect(prepare.mock.calls.map(([input]) => input.purpose)).toEqual([
      "live",
      "preview",
      "copy",
      "send",
      "send",
    ]);
    expect(prepare.mock.calls.map(([input]) => input.mode)).toEqual([
      "chat",
      "chat",
      "chat",
      "chat",
      "agent",
    ]);
  });

  it("promotes recalled context only for an authorized completed send", async () => {
    restoreRegistration = registerChatContextPreparation({
      prepare: async (input) =>
        prepared(input, [{ messageId: "recall-1", text: "Remember me" }]),
      isAuthorityCurrent: () => true,
    });
    const refresh = useChatStore.getState().refreshContextLayers;

    for (let index = 0; index < 3; index += 1) {
      await refresh({
        purpose: "preview",
        privacy: "private",
        trackRecallPromote: true,
        strict: true,
      });
      await refresh({
        purpose: "send",
        privacy: "private",
        trackRecallPromote: true,
        isAuthorized: () => false,
        strict: true,
      });
    }
    expect(useChatStore.getState().chatRecallPromoteSuggestion).toBeNull();

    for (let index = 0; index < 3; index += 1) {
      await refresh({
        purpose: "send",
        privacy: "private",
        trackRecallPromote: true,
        isAuthorized: () => true,
        strict: true,
      });
    }
    expect(useChatStore.getState().chatRecallPromoteSuggestion).toEqual({
      messageId: "recall-1",
      text: "Remember me",
    });
  });
});
