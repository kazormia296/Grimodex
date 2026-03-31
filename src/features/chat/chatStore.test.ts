import { describe, it, expect, beforeEach, vi } from "vitest";
import { useChatStore } from "./chatStore";
import type { ChatMessage, ChatThread } from "./chatTypes";

vi.mock("./chatApi", () => ({
  sendChatMessage: vi.fn(),
  listThreads: vi.fn(),
  createThread: vi.fn(),
  deleteThread: vi.fn(),
  listMessages: vi.fn(),
  addMessage: vi.fn(),
  updateThreadTitle: vi.fn(),
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
    Promise.resolve({
      id: 1,
      title: "テストプロジェクト",
      description: "概要",
    }),
  ),
}));

import * as chatApi from "./chatApi";
import * as contextBuilder from "./contextBuilder";
const mockSendChatMessage = vi.mocked(chatApi.sendChatMessage);
const mockBuildSystemPrompt = vi.mocked(contextBuilder.buildSystemPrompt);
const mockCountTokens = vi.mocked(contextBuilder.countTokens);
const mockListThreads = vi.mocked(chatApi.listThreads);
const mockCreateThread = vi.mocked(chatApi.createThread);
const mockDeleteThread = vi.mocked(chatApi.deleteThread);
const mockListMessages = vi.mocked(chatApi.listMessages);
const mockAddMessage = vi.mocked(chatApi.addMessage);

function resetStore() {
  useChatStore.setState({
    threads: [],
    activeThreadId: null,
    isLoadingThreads: false,
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
  return {
    id,
    threadId: "thread-1",
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

const thread1: ChatThread = {
  id: "thread-1",
  title: "会話1",
  sceneId: "scene-1",
  createdAt: "2025-01-01T00:00:00Z",
  modifiedAt: "2025-01-01T00:00:00Z",
};

const thread2: ChatThread = {
  id: "thread-2",
  title: "会話2",
  sceneId: "scene-1",
  createdAt: "2025-01-01T00:01:00Z",
  modifiedAt: "2025-01-01T00:01:00Z",
};

const msg1: ChatMessage = {
  id: "msg-1",
  threadId: "thread-1",
  role: "user",
  content: "こんにちは",
  createdAt: "2025-01-01T00:00:00Z",
};

const msg2: ChatMessage = {
  id: "msg-2",
  threadId: "thread-1",
  role: "assistant",
  content: "こんにちは！お手伝いします。",
  createdAt: "2025-01-01T00:00:01Z",
};

describe("useChatStore", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  // --- Thread management tests (Task 2.5) ---

  describe("loadThreads", () => {
    it("loads threads for a scene", async () => {
      mockListThreads.mockResolvedValueOnce([thread1, thread2]);

      await useChatStore.getState().loadThreads("scene-1");

      const state = useChatStore.getState();
      expect(state.threads).toHaveLength(2);
      expect(mockListThreads).toHaveBeenCalledWith("scene-1");
    });

    it("loads all threads when no sceneId given", async () => {
      mockListThreads.mockResolvedValueOnce([thread1]);

      await useChatStore.getState().loadThreads();

      expect(mockListThreads).toHaveBeenCalledWith(undefined);
    });

    it("sets isLoadingThreads during load", async () => {
      let resolvePromise: (value: ChatThread[]) => void;
      const promise = new Promise<ChatThread[]>((resolve) => {
        resolvePromise = resolve;
      });
      mockListThreads.mockReturnValueOnce(promise);

      const loadPromise = useChatStore.getState().loadThreads("scene-1");
      expect(useChatStore.getState().isLoadingThreads).toBe(true);

      resolvePromise!([thread1]);
      await loadPromise;

      expect(useChatStore.getState().isLoadingThreads).toBe(false);
    });
  });

  describe("selectThread", () => {
    it("sets active thread and loads its messages", async () => {
      useChatStore.setState({ threads: [thread1, thread2] });
      mockListMessages.mockResolvedValueOnce([msg1, msg2]);

      await useChatStore.getState().selectThread("thread-1");

      const state = useChatStore.getState();
      expect(state.activeThreadId).toBe("thread-1");
      expect(state.messages).toHaveLength(2);
      expect(mockListMessages).toHaveBeenCalledWith("thread-1");
    });

    it("clears messages when selecting null", async () => {
      useChatStore.setState({
        activeThreadId: "thread-1",
        messages: [msg1],
      });

      await useChatStore.getState().selectThread(null);

      const state = useChatStore.getState();
      expect(state.activeThreadId).toBeNull();
      expect(state.messages).toEqual([]);
    });
  });

  describe("createNewThread", () => {
    it("creates a thread and selects it", async () => {
      mockCreateThread.mockResolvedValueOnce(thread1);

      await useChatStore.getState().createNewThread("会話1", "scene-1");

      const state = useChatStore.getState();
      expect(mockCreateThread).toHaveBeenCalledWith("会話1", "scene-1");
      expect(state.threads).toContainEqual(thread1);
      expect(state.activeThreadId).toBe("thread-1");
    });
  });

  describe("deleteThread", () => {
    it("deletes a thread and clears selection if active", async () => {
      useChatStore.setState({
        threads: [thread1, thread2],
        activeThreadId: "thread-1",
        messages: [msg1],
      });
      mockDeleteThread.mockResolvedValueOnce(undefined);

      await useChatStore.getState().deleteThread("thread-1");

      const state = useChatStore.getState();
      expect(state.threads).toHaveLength(1);
      expect(state.threads[0].id).toBe("thread-2");
      expect(state.activeThreadId).toBeNull();
      expect(state.messages).toEqual([]);
    });

    it("does not clear selection when deleting non-active thread", async () => {
      useChatStore.setState({
        threads: [thread1, thread2],
        activeThreadId: "thread-1",
        messages: [msg1],
      });
      mockDeleteThread.mockResolvedValueOnce(undefined);

      await useChatStore.getState().deleteThread("thread-2");

      const state = useChatStore.getState();
      expect(state.threads).toHaveLength(1);
      expect(state.activeThreadId).toBe("thread-1");
      expect(state.messages).toEqual([msg1]);
    });
  });

  describe("persistMessage", () => {
    it("adds a message to the current thread", async () => {
      useChatStore.setState({
        threads: [thread1],
        activeThreadId: "thread-1",
        messages: [],
      });
      mockAddMessage.mockResolvedValueOnce(msg1);

      await useChatStore.getState().persistMessage("user", "こんにちは");

      const state = useChatStore.getState();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].content).toBe("こんにちは");
      expect(mockAddMessage).toHaveBeenCalledWith(
        "thread-1",
        "user",
        "こんにちは",
      );
    });

    it("does nothing when no active thread", async () => {
      useChatStore.setState({ activeThreadId: null });

      await useChatStore.getState().persistMessage("user", "test");

      expect(mockAddMessage).not.toHaveBeenCalled();
    });
  });

  // --- Existing streaming chat tests ---

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

    it("passes full message history to API with system prompt prepended", async () => {
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
      // system + 前の質問 + 前の回答 + 新しい質問 = 4
      expect(passedMessages).toHaveLength(4);
      expect(passedMessages[0].role).toBe("system");
      expect(passedMessages[1].content).toBe("前の質問");
      expect(passedMessages[2].content).toBe("前の回答");
      expect(passedMessages[3].content).toBe("新しい質問");
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
