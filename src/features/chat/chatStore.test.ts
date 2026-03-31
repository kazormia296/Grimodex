import { describe, it, expect, beforeEach, vi } from "vitest";
import { useChatStore } from "./chatStore";
import type { ChatMessage } from "./chatTypes";

vi.mock("./chatApi", () => ({
  sendChatMessage: vi.fn(),
}));

vi.mock("./contextBuilder", () => ({
  buildSystemPrompt: vi.fn(() => "mock system prompt"),
  countTokens: vi.fn(() => 42),
}));

vi.mock("@/features/scene/api", () => ({
  loadSceneContent: vi.fn(() => Promise.resolve("シーン本文")),
  getScene: vi.fn(() =>
    Promise.resolve({
      id: "scene-1",
      chapterId: 1,
      title: "テストシーン",
      sortOrder: 0,
      synopsis: "",
      createdAt: "",
      updatedAt: "",
    }),
  ),
}));

vi.mock("@/features/project/api", () => ({
  getProject: vi.fn(() =>
    Promise.resolve({ id: 1, title: "テストプロジェクト", description: "概要" }),
  ),
}));

import * as chatApi from "./chatApi";
import * as contextBuilder from "./contextBuilder";
const mockSendChatMessage = vi.mocked(chatApi.sendChatMessage);
const mockBuildSystemPrompt = vi.mocked(contextBuilder.buildSystemPrompt);
const mockCountTokens = vi.mocked(contextBuilder.countTokens);

function resetStore() {
  useChatStore.setState({
    messages: [],
    isStreaming: false,
    error: null,
    activeSceneId: "scene-1",
    activeProjectId: 1,
    contextTokenCount: 0,
  });
}

function makeMessage(
  role: "user" | "assistant",
  content: string,
  id = crypto.randomUUID(),
): ChatMessage {
  return { id, role, content, createdAt: new Date().toISOString() };
}

describe("useChatStore", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  describe("addUserMessage", () => {
    it("adds a user message to the list", () => {
      useChatStore.getState().addUserMessage("こんにちは");

      const { messages } = useChatStore.getState();
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("こんにちは");
      expect(messages[0].id).toBeTruthy();
      expect(messages[0].createdAt).toBeTruthy();
    });

    it("appends to existing messages", () => {
      useChatStore.getState().addUserMessage("1つ目");
      useChatStore.getState().addUserMessage("2つ目");

      expect(useChatStore.getState().messages).toHaveLength(2);
    });
  });

  describe("sendMessage", () => {
    it("adds user message, sets streaming, and appends assistant response", async () => {
      mockSendChatMessage.mockImplementation(async (_msgs, onChunk) => {
        onChunk("こんに");
        onChunk("ちは！");
      });

      await useChatStore.getState().sendMessage("テスト");

      const { messages, isStreaming } = useChatStore.getState();
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("テスト");
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toBe("こんにちは！");
      expect(isStreaming).toBe(false);
    });

    it("sets isStreaming to true during API call", async () => {
      let streamingDuringCall = false;
      mockSendChatMessage.mockImplementation(async () => {
        streamingDuringCall = useChatStore.getState().isStreaming;
      });

      await useChatStore.getState().sendMessage("テスト");

      expect(streamingDuringCall).toBe(true);
      expect(useChatStore.getState().isStreaming).toBe(false);
    });

    it("sets error on API failure", async () => {
      mockSendChatMessage.mockRejectedValueOnce(new Error("API error"));

      await useChatStore.getState().sendMessage("テスト");

      const { error, isStreaming } = useChatStore.getState();
      expect(error).toBe("API error");
      expect(isStreaming).toBe(false);
    });

    it("does not send when already streaming", async () => {
      useChatStore.setState({ isStreaming: true });

      await useChatStore.getState().sendMessage("テスト");

      expect(mockSendChatMessage).not.toHaveBeenCalled();
    });

    it("does not send empty messages", async () => {
      await useChatStore.getState().sendMessage("   ");

      expect(mockSendChatMessage).not.toHaveBeenCalled();
    });

    it("passes full message history to API", async () => {
      useChatStore.setState({
        messages: [
          makeMessage("user", "前の質問"),
          makeMessage("assistant", "前の回答"),
        ],
      });
      mockSendChatMessage.mockImplementation(async (_msgs, onChunk) => {
        onChunk("新しい回答");
      });

      await useChatStore.getState().sendMessage("新しい質問");

      const passedMessages = mockSendChatMessage.mock.calls[0][0];
      expect(passedMessages).toHaveLength(3);
      expect(passedMessages[0].content).toBe("前の質問");
      expect(passedMessages[1].content).toBe("前の回答");
      expect(passedMessages[2].content).toBe("新しい質問");
    });
  });

  describe("clearMessages", () => {
    it("clears all messages", () => {
      useChatStore.setState({
        messages: [makeMessage("user", "テスト")],
      });

      useChatStore.getState().clearMessages();

      expect(useChatStore.getState().messages).toHaveLength(0);
    });
  });

  describe("clearError", () => {
    it("clears the error state", () => {
      useChatStore.setState({ error: "some error" });

      useChatStore.getState().clearError();

      expect(useChatStore.getState().error).toBeNull();
    });
  });

  describe("context injection", () => {
    it("passes system prompt to sendChatMessage", async () => {
      mockBuildSystemPrompt.mockReturnValue("テスト用システムプロンプト");
      mockSendChatMessage.mockImplementation(async (_msgs, onChunk) => {
        onChunk("回答");
      });

      await useChatStore.getState().sendMessage("質問");

      expect(mockSendChatMessage).toHaveBeenCalled();
      const callArgs = mockSendChatMessage.mock.calls[0];
      const messages = callArgs[0];
      // First message should be system prompt
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toBe("テスト用システムプロンプト");
    });

    it("updates contextTokenCount when context changes", async () => {
      mockCountTokens.mockReturnValue(100);
      mockSendChatMessage.mockImplementation(async (_msgs, onChunk) => {
        onChunk("回答");
      });

      await useChatStore.getState().sendMessage("質問");

      const { contextTokenCount } = useChatStore.getState();
      expect(contextTokenCount).toBe(100);
    });

    it("sets activeSceneId and updates context", () => {
      useChatStore.getState().setActiveSceneId("scene-2");

      expect(useChatStore.getState().activeSceneId).toBe("scene-2");
    });

    it("sets activeProjectId", () => {
      useChatStore.getState().setActiveProjectId(2);

      expect(useChatStore.getState().activeProjectId).toBe(2);
    });
  });
});
