import { describe, it, expect, beforeEach, vi } from "vitest";
import { useChatStore } from "./chatStore";
import type { ChatMessage, ChatSession } from "./chatTypes";

vi.mock("./chatApi", () => ({
  sendChatMessage: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  listMessages: vi.fn(),
  addMessage: vi.fn(),
  updateSessionTitle: vi.fn(),
  listPinnedCodexEntries: vi.fn(() => Promise.resolve([])),
  pinCodexEntry: vi.fn(),
  unpinCodexEntry: vi.fn(),
}));

vi.mock("./contextBuilder", () => ({
  buildSystemPrompt: vi.fn(() => "mock system prompt"),
  buildStorySoFar: vi.fn(() => ""),
  countTokens: vi.fn(() => 42),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: Object.assign(
    vi.fn(() => ({ nodes: [] })),
    { getState: vi.fn(() => ({ nodes: [] })) },
  ),
}));

vi.mock("@/features/tree/api", () => ({
  loadSceneContent: vi.fn(() => Promise.resolve("シーン本文")),
  getNode: vi.fn(() =>
    Promise.resolve({
      id: "scene-1",
      title: "テストシーン",
    }),
  ),
}));

vi.mock("@/features/project/api", () => ({
  getProject: vi.fn(() =>
    Promise.resolve({
      id: "proj-1",
      title: "テストプロジェクト",
      genre: "ファンタジー",
    }),
  ),
}));

vi.mock("@/features/codex/api", () => ({
  listCodexEntries: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/features/codex/codexMatcher", () => ({
  findMentionedEntries: vi.fn(() => []),
}));

import * as chatApi from "./chatApi";
import * as contextBuilder from "./contextBuilder";
const mockSendChatMessage = vi.mocked(chatApi.sendChatMessage);
const mockBuildSystemPrompt = vi.mocked(contextBuilder.buildSystemPrompt);
const mockCountTokens = vi.mocked(contextBuilder.countTokens);
const mockListSessions = vi.mocked(chatApi.listSessions);
const mockCreateSession = vi.mocked(chatApi.createSession);
const mockDeleteSession = vi.mocked(chatApi.deleteSession);
const mockListMessages = vi.mocked(chatApi.listMessages);
const mockAddMessage = vi.mocked(chatApi.addMessage);

function resetStore() {
  useChatStore.setState({
    sessions: [],
    activeSessionId: null,
    isLoadingSessions: false,
    messages: [],
    isStreaming: false,
    error: null,
    activeSceneId: "scene-1",
    activeProjectId: "proj-1",
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
    sessionId: "session-1",
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

const session1: ChatSession = {
  id: "session-1",
  projectId: "proj-1",
  nodeId: "scene-1",
  title: "会話1",
  titleManual: 0,
  model: "openrouter/anthropic/claude-sonnet-4.6",
  pinnedCodex: "[]",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

const session2: ChatSession = {
  id: "session-2",
  projectId: "proj-1",
  nodeId: "scene-1",
  title: "会話2",
  titleManual: 0,
  model: "openrouter/anthropic/claude-sonnet-4.6",
  pinnedCodex: "[]",
  createdAt: "2025-01-01T00:01:00Z",
  updatedAt: "2025-01-01T00:01:00Z",
};

const msg1: ChatMessage = {
  id: "msg-1",
  sessionId: "session-1",
  role: "user",
  content: "こんにちは",
  createdAt: "2025-01-01T00:00:00Z",
};

const msg2: ChatMessage = {
  id: "msg-2",
  sessionId: "session-1",
  role: "assistant",
  content: "こんにちは！お手伝いします。",
  createdAt: "2025-01-01T00:00:01Z",
};

describe("useChatStore", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  // --- Session management tests ---

  describe("loadSessions", () => {
    it("loads sessions for a scene", async () => {
      mockListSessions.mockResolvedValueOnce([session1, session2]);

      await useChatStore.getState().loadSessions("scene-1");

      const state = useChatStore.getState();
      expect(state.sessions).toHaveLength(2);
      expect(mockListSessions).toHaveBeenCalledWith("scene-1");
    });

    it("loads all sessions when no nodeId given", async () => {
      mockListSessions.mockResolvedValueOnce([session1]);

      await useChatStore.getState().loadSessions();

      expect(mockListSessions).toHaveBeenCalledWith(undefined);
    });

    it("sets isLoadingSessions during load", async () => {
      let resolvePromise: (value: ChatSession[]) => void;
      const promise = new Promise<ChatSession[]>((resolve) => {
        resolvePromise = resolve;
      });
      mockListSessions.mockReturnValueOnce(promise);

      const loadPromise = useChatStore.getState().loadSessions("scene-1");
      expect(useChatStore.getState().isLoadingSessions).toBe(true);

      resolvePromise!([session1]);
      await loadPromise;

      expect(useChatStore.getState().isLoadingSessions).toBe(false);
    });
  });

  describe("selectSession", () => {
    it("sets active session and loads its messages", async () => {
      useChatStore.setState({ sessions: [session1, session2] });
      mockListMessages.mockResolvedValueOnce([msg1, msg2]);

      await useChatStore.getState().selectSession("session-1");

      const state = useChatStore.getState();
      expect(state.activeSessionId).toBe("session-1");
      expect(state.messages).toHaveLength(2);
      expect(mockListMessages).toHaveBeenCalledWith("session-1");
    });

    it("clears messages when selecting null", async () => {
      useChatStore.setState({
        activeSessionId: "session-1",
        messages: [msg1],
      });

      await useChatStore.getState().selectSession(null);

      const state = useChatStore.getState();
      expect(state.activeSessionId).toBeNull();
      expect(state.messages).toEqual([]);
    });
  });

  describe("createNewSession", () => {
    it("creates a session and selects it", async () => {
      mockCreateSession.mockResolvedValueOnce(session1);

      await useChatStore
        .getState()
        .createNewSession("proj-1", "会話1", "scene-1");

      const state = useChatStore.getState();
      expect(mockCreateSession).toHaveBeenCalledWith(
        "proj-1",
        "会話1",
        "scene-1",
      );
      expect(state.sessions).toContainEqual(session1);
      expect(state.activeSessionId).toBe("session-1");
    });
  });

  describe("deleteSession", () => {
    it("deletes a session and clears selection if active", async () => {
      useChatStore.setState({
        sessions: [session1, session2],
        activeSessionId: "session-1",
        messages: [msg1],
      });
      mockDeleteSession.mockResolvedValueOnce(undefined);

      await useChatStore.getState().deleteSession("session-1");

      const state = useChatStore.getState();
      expect(state.sessions).toHaveLength(1);
      expect(state.sessions[0].id).toBe("session-2");
      expect(state.activeSessionId).toBeNull();
      expect(state.messages).toEqual([]);
    });

    it("does not clear selection when deleting non-active session", async () => {
      useChatStore.setState({
        sessions: [session1, session2],
        activeSessionId: "session-1",
        messages: [msg1],
      });
      mockDeleteSession.mockResolvedValueOnce(undefined);

      await useChatStore.getState().deleteSession("session-2");

      const state = useChatStore.getState();
      expect(state.sessions).toHaveLength(1);
      expect(state.activeSessionId).toBe("session-1");
      expect(state.messages).toEqual([msg1]);
    });
  });

  describe("persistMessage", () => {
    it("adds a message to the current session", async () => {
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: "session-1",
        messages: [],
      });
      mockAddMessage.mockResolvedValueOnce(msg1);

      await useChatStore.getState().persistMessage("user", "こんにちは");

      const state = useChatStore.getState();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].content).toBe("こんにちは");
      expect(mockAddMessage).toHaveBeenCalledWith(
        "session-1",
        "user",
        "こんにちは",
      );
    });

    it("does nothing when no active session", async () => {
      useChatStore.setState({ activeSessionId: null });

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
      useChatStore.getState().setActiveProjectId("proj-2");

      expect(useChatStore.getState().activeProjectId).toBe("proj-2");
    });
  });
});
