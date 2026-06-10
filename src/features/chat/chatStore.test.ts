import { describe, it, expect, beforeEach, vi } from "vitest";
import { useChatStore } from "./chatStore";
import { useProjectStore } from "@/features/project/projectStore";
import type { ChatMessage, ChatSession } from "./chatTypes";

vi.mock("./chatApi", () => ({
  sendChatMessage: vi.fn(),
  sendChatMessageWithThinking: vi.fn(),
  sendChatMessageStream: vi.fn(),
  abortChatStream: vi.fn(() => Promise.resolve()),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  listMessages: vi.fn(),
  listSummaries: vi.fn(() => Promise.resolve([])),
  addMessage: vi.fn(),
  updateSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(() => Promise.resolve(null)),
  listPinnedCodexEntries: vi.fn(() => Promise.resolve([])),
  listPinnedSnippetEntries: vi.fn(() => Promise.resolve([])),
  pinCodexEntry: vi.fn(),
  unpinCodexEntry: vi.fn(),
}));

vi.mock("./contextBuilder", () => ({
  buildSystemPrompt: vi.fn(() => ({
    prompt: "mock system prompt",
    totalTokens: 42,
    layers: [],
  })),
  buildStorySoFar: vi.fn(() => ""),
  countTokens: vi.fn(() => 42),
  allocateLayerBudgets: vi.fn(() => ({
    responseReservation: 10_000,
    l1: 4_000,
    l2: 19_000,
    l3: 76_000,
    l4: 38_000,
    l5: 38_000,
    degraded: false,
  })),
  ensureTokenizer: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/features/codex/prosemirrorTextExtractor", () => ({
  extractPlainText: vi.fn(() => ""),
}));

vi.mock("@/features/tree/treeStore", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/tree/treeStore")>();
  return {
    ...actual,
    useTreeStore: Object.assign(
      vi.fn(() => ({ nodes: [] })),
      { getState: vi.fn(() => ({ nodes: [] })) },
    ),
  };
});

vi.mock("@/features/tree/api", () => {
  const loadSceneFull = vi.fn((_id: string) =>
    Promise.resolve({ content: "{}", unplacedBeatsDoc: "[]" }),
  );
  return {
    loadSceneContent: vi.fn(() => Promise.resolve("シーン本文")),
    loadSceneFull,
    // バッチ版は per-scene の loadSceneFull mock に fan-out させ、既存テストの
    // mockImplementation / mockResolvedValue / call-count アサートをそのまま活かす。
    loadScenesFull: vi.fn(async (ids: string[]) => {
      const map = new Map<
        string,
        { content: string; unplacedBeatsDoc: string }
      >();
      for (const id of ids) map.set(id, await loadSceneFull(id));
      return map;
    }),
    getNode: vi.fn(() =>
      Promise.resolve({
        id: "scene-1",
        title: "テストシーン",
      }),
    ),
  };
});

vi.mock("@/features/project/api", () => ({
  getProject: vi.fn(() =>
    Promise.resolve({
      id: "proj-1",
      title: "テストプロジェクト",
      genre: "ファンタジー",
      language: "ja",
    }),
  ),
}));

vi.mock("@/features/codex/api", () => ({
  listCodexEntries: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/features/codex/codexMatcher", () => ({
  findMentionedEntries: vi.fn(() => []),
}));

vi.mock("@/features/codex/rustMatcher", () => ({
  findMentionedEntriesAsync: vi.fn(() => Promise.resolve([])),
}));

import * as chatApi from "./chatApi";
import type { StreamCallbacks } from "./chatApi";
import * as contextBuilder from "./contextBuilder";
const mockSendChatMessageStream = vi.mocked(chatApi.sendChatMessageStream);
const mockBuildSystemPrompt = vi.mocked(contextBuilder.buildSystemPrompt);

/**
 * Helper: set up sendChatMessageStream mock to immediately call onTextDelta + onDone.
 */
function mockStreamResponse(text: string) {
  mockSendChatMessageStream.mockImplementation(
    async (_messages, _params, callbacks: StreamCallbacks) => {
      callbacks.onTextDelta(text);
      callbacks.onDone({ stopReason: "end_turn" });
      return () => {};
    },
  );
}

/**
 * Helper: set up sendChatMessageStream mock to call onError.
 */
function mockStreamError(message: string) {
  mockSendChatMessageStream.mockImplementation(
    async (_messages, _params, callbacks: StreamCallbacks) => {
      callbacks.onError(message);
      return () => {};
    },
  );
}

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
  codexAnchorId: null,
  title: "会話1",
  titleManual: 0,
  model: "openrouter/anthropic/claude-sonnet-4.6",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

const session2: ChatSession = {
  id: "session-2",
  projectId: "proj-1",
  nodeId: "scene-1",
  codexAnchorId: null,
  title: "会話2",
  titleManual: 0,
  model: "openrouter/anthropic/claude-sonnet-4.6",
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
    // policy 既定はクリア（projects 空 → fail-open=full）。chat ガードを
    // 素通りさせ、既存の sendMessage テストを従来どおり走らせる。
    useProjectStore.setState({ currentProjectId: null, projects: [] });
  });

  // --- Session management tests ---

  describe("loadSessions", () => {
    it("loads sessions for a scene", async () => {
      mockListSessions.mockResolvedValueOnce([session1, session2]);

      await useChatStore.getState().loadSessions("scene-1");

      const state = useChatStore.getState();
      expect(state.sessions).toHaveLength(2);
      expect(mockListSessions).toHaveBeenCalledWith("scene-1", undefined);
    });

    it("loads all sessions when no nodeId given", async () => {
      mockListSessions.mockResolvedValueOnce([session1]);

      await useChatStore.getState().loadSessions();

      expect(mockListSessions).toHaveBeenCalledWith(undefined, undefined);
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

  // ask_user の回答待ち中に起きる「非自発的キャンセル」経路の配線テスト。
  // ループ自体の中断（shouldAbort → 再発火しない）は agentLoop.test.ts で gate
  // 済み。ここではセッション切替 / Stop が回答待ちを残さず畳むことを保証する
  // （切替時に pending を残すと別セッションへカードが漏れ、resolver もリークする）。
  describe("ask_user cancellation wiring", () => {
    const makePending = (sessionId: string | null) => ({
      sessionId,
      toolCallId: "tc-1",
      spec: {
        questions: [
          {
            question: "Q",
            kind: "text" as const,
            options: [],
            allowFreeText: false,
          },
        ],
      },
      dismissNote: "DISMISS",
    });

    it("clears a pending question when switching to another session", async () => {
      useChatStore.setState({ sessions: [session1, session2] });
      mockListMessages.mockResolvedValueOnce([]);
      useChatStore.setState({
        activeSessionId: "session-1",
        pendingUserQuestion: makePending("session-1"),
      });

      await useChatStore.getState().selectSession("session-2");

      expect(useChatStore.getState().pendingUserQuestion).toBeNull();
    });

    it("clears a pending question when switching to null", async () => {
      useChatStore.setState({
        activeSessionId: "session-1",
        pendingUserQuestion: makePending("session-1"),
      });

      await useChatStore.getState().selectSession(null);

      expect(useChatStore.getState().pendingUserQuestion).toBeNull();
    });

    it("clears a pending question and stops streaming on stopGeneration", () => {
      useChatStore.setState({
        activeSessionId: "session-1",
        isStreaming: true,
        pendingUserQuestion: makePending("session-1"),
      });

      useChatStore.getState().stopGeneration();

      const state = useChatStore.getState();
      expect(state.pendingUserQuestion).toBeNull();
      expect(state.isStreaming).toBe(false);
    });

    it("ignores a resolve targeting a different session (no-op)", () => {
      useChatStore.setState({
        activeSessionId: "session-2",
        pendingUserQuestion: makePending("session-1"),
      });

      useChatStore.getState().resolveUserQuestion({ answers: [] });

      // session 不一致 → 適用せず pending を残す。
      expect(useChatStore.getState().pendingUserQuestion).not.toBeNull();
    });

    it("clears a pending question when the answering session matches", () => {
      useChatStore.setState({
        activeSessionId: "session-1",
        pendingUserQuestion: makePending("session-1"),
      });

      useChatStore.getState().resolveUserQuestion({
        answers: [{ questionIndex: 0, question: "Q", text: "A" }],
      });

      expect(useChatStore.getState().pendingUserQuestion).toBeNull();
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
        undefined,
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

  // --- sendMessage tests ---

  describe("sendMessage", () => {
    it("adds user message, sets streaming, and appends assistant response", async () => {
      mockStreamResponse("こんにちは！");

      await useChatStore.getState().sendMessage("テスト");

      const { messages, isStreaming } = useChatStore.getState();
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("テスト");
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toBe("こんにちは！");
      expect(isStreaming).toBe(false);
    });

    it("coalesces multiple text deltas into the final assistant content without dropping the tail", async () => {
      // perf 所見#1b: onTextDelta は rAF でまとめて flush されるが、onDone で
      // 同期 flush されるため最終 content は全 delta の連結と一致する。
      mockSendChatMessageStream.mockImplementation(
        async (_messages, _params, callbacks: StreamCallbacks) => {
          callbacks.onTextDelta("あ");
          callbacks.onTextDelta("い");
          callbacks.onTextDelta("う");
          callbacks.onDone({ stopReason: "end_turn" });
          return () => {};
        },
      );

      await useChatStore.getState().sendMessage("テスト");

      const { messages } = useChatStore.getState();
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toBe("あいう");
    });

    it("flushes the coalesced tail on error so partial content is preserved", async () => {
      // chatStore.ts onError は flushDelta() を同期実行し、rAF にバッファ済みの
      // delta を取りこぼさず assistant メッセージに反映してから reject する。
      mockSendChatMessageStream.mockImplementation(
        async (_messages, _params, callbacks: StreamCallbacks) => {
          callbacks.onTextDelta("途中ま");
          callbacks.onTextDelta("で");
          callbacks.onError("ストリーム中断");
          return () => {};
        },
      );

      await useChatStore.getState().sendMessage("テスト");

      const { messages, error } = useChatStore.getState();
      const assistant = messages.find((m) => m.role === "assistant");
      expect(assistant?.content).toBe("途中まで");
      expect(error).toBe("ストリーム中断");
    });

    it("sets isStreaming to true during API call", async () => {
      let streamingDuringCall = false;
      mockSendChatMessageStream.mockImplementation(
        async (_messages, _params, callbacks: StreamCallbacks) => {
          streamingDuringCall = useChatStore.getState().isStreaming;
          callbacks.onTextDelta("");
          callbacks.onDone({ stopReason: "end_turn" });
          return () => {};
        },
      );

      await useChatStore.getState().sendMessage("テスト");

      expect(streamingDuringCall).toBe(true);
      expect(useChatStore.getState().isStreaming).toBe(false);
    });

    it("sets error on API failure", async () => {
      mockStreamError("API error");

      await useChatStore.getState().sendMessage("テスト");

      const { error, isStreaming } = useChatStore.getState();
      expect(error).toBe("API error");
      expect(isStreaming).toBe(false);
    });

    it("does not send when already streaming", async () => {
      useChatStore.setState({ isStreaming: true });

      await useChatStore.getState().sendMessage("テスト");

      expect(mockSendChatMessageStream).not.toHaveBeenCalled();
    });

    it("does not send empty messages", async () => {
      await useChatStore.getState().sendMessage("   ");

      expect(mockSendChatMessageStream).not.toHaveBeenCalled();
    });

    it("policy bypass: chat=off blocks send before streaming or appending", async () => {
      // Send ボタンは hide/disabled になるが、Enter / Cmd+Enter / regenerate /
      // agent 再入は sendMessage に直行する。chat=off ならここで弾けていること。
      useProjectStore.setState({
        currentProjectId: "proj-1",
        projects: [
          {
            id: "proj-1",
            aiPolicy: JSON.stringify({
              preset: "review-only",
              toggles: { chat: false, bodyWrite: false, analysis: true },
            }),
          },
        ] as never,
      });
      mockStreamResponse("返信");

      await useChatStore.getState().sendMessage("テスト");

      expect(mockSendChatMessageStream).not.toHaveBeenCalled();
      expect(useChatStore.getState().messages).toHaveLength(0);
    });

    it("passes full message history to API with system prompt prepended", async () => {
      useChatStore.setState({
        messages: [
          makeMessage("user", "前の質問"),
          makeMessage("assistant", "前の回答"),
        ],
      });
      mockStreamResponse("新しい回答");

      await useChatStore.getState().sendMessage("新しい質問");

      const passedMessages = mockSendChatMessageStream.mock.calls[0][0];
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

  describe("classifyError — streaming errors", () => {
    it("sets error state when streaming fails", async () => {
      mockStreamError("context_length_exceeded");

      await useChatStore.getState().sendMessage("テスト");

      const { error } = useChatStore.getState();
      expect(error).toBeTruthy();
    });

    it("sets error state when streaming fails with network error", async () => {
      mockStreamError("network connection failed");

      await useChatStore.getState().sendMessage("テスト");

      const { error } = useChatStore.getState();
      expect(error).toBeTruthy();
    });
  });

  describe("context injection", () => {
    it("passes system prompt to sendChatMessageStream", async () => {
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "テスト用システムプロンプト",
        totalTokens: 50,
        layers: [],
      });
      mockStreamResponse("回答");

      await useChatStore.getState().sendMessage("質問");

      expect(mockSendChatMessageStream).toHaveBeenCalled();
      const callArgs = mockSendChatMessageStream.mock.calls[0];
      const messages = callArgs[0];
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toBe("テスト用システムプロンプト");
    });

    it("updates contextTokenCount when context changes", async () => {
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "mock system prompt",
        totalTokens: 100,
        layers: [],
      });
      mockStreamResponse("回答");

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

  // --- シーンなし時のシステムプロンプトフォールバック ---

  describe("lastSystemPrompt fallback (no active scene)", () => {
    it("sendMessage injects lastSystemPrompt as system message when no scene", async () => {
      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: null,
        lastSystemPrompt: "フォールバックプロンプト",
      });
      mockStreamResponse("回答");

      await useChatStore.getState().sendMessage("テスト");

      const passedMessages = mockSendChatMessageStream.mock.calls[0][0];
      expect(passedMessages[0].role).toBe("system");
      expect(passedMessages[0].content).toBe("フォールバックプロンプト");
    });

    it("sendMessage sends no system message when lastSystemPrompt is empty", async () => {
      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: null,
        lastSystemPrompt: "",
      });
      mockStreamResponse("回答");

      await useChatStore.getState().sendMessage("テスト");

      const passedMessages = mockSendChatMessageStream.mock.calls[0][0];
      expect(passedMessages[0].role).toBe("user");
    });

    it("buildPromptForCopy uses lastSystemPrompt as fallback when no scene", async () => {
      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: null,
        lastSystemPrompt: "フォールバックプロンプト",
        messages: [],
      });

      const result = await useChatStore
        .getState()
        .buildPromptForCopy("ユーザー入力");

      expect(result).toContain("[system]\nフォールバックプロンプト");
      expect(result).toContain("[user]\nユーザー入力");
    });

    it("buildPromptForCopy omits system block when lastSystemPrompt is empty", async () => {
      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: null,
        lastSystemPrompt: "",
        messages: [],
      });

      const result = await useChatStore
        .getState()
        .buildPromptForCopy("ユーザー入力");

      expect(result).not.toContain("[system]");
      expect(result).toContain("[user]\nユーザー入力");
    });

    it("buildPromptForCopy uses lastSystemPrompt for project scope instead of empty scene prompt", async () => {
      mockBuildSystemPrompt.mockClear();
      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        chatScope: "project",
        scopeAnchorId: null,
        lastSystemPrompt: "=== Act 1 ===\nOutline: 集約済みプロンプト",
        messages: [],
      });

      const result = await useChatStore
        .getState()
        .buildPromptForCopy("ユーザー入力");

      expect(result).toContain("[system]\n=== Act 1 ===");
      expect(result).toContain("集約済みプロンプト");
      expect(mockBuildSystemPrompt).not.toHaveBeenCalled();
    });

    it("buildPromptForCopy refreshes context when lastSystemPrompt is empty in project scope", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const folder = {
        id: "ch1",
        parentId: null,
        nodeType: "folder" as const,
        title: "Ch",
        sortOrder: "a0",
        synopsis: "章",
        charCount: 0,
      };
      const scene = {
        id: "s1",
        parentId: "ch1",
        nodeType: "scene" as const,
        title: "S1",
        sortOrder: "a0",
        synopsis: "あらすじ",
        charCount: 10,
      };

      mockTreeState.mockReturnValue({
        // @ts-expect-error stub
        nodes: [folder, scene],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "refresh で組み立てたプロンプト",
        totalTokens: 10,
        layers: [],
      });

      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        chatScope: "project",
        scopeAnchorId: null,
        lastSystemPrompt: "",
        messages: [],
        includeBodies: false,
      });

      const result = await useChatStore
        .getState()
        .buildPromptForCopy("コピー用");

      expect(result).toContain("[system]\nrefresh で組み立てたプロンプト");
      expect(mockBuildSystemPrompt).toHaveBeenCalled();
    });

    it("buildPromptForCopy with mentions reverts lastSystemPrompt so next send isn't polluted", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const folder = {
        id: "ch1",
        parentId: null,
        nodeType: "folder" as const,
        title: "Ch",
        sortOrder: "a0",
        synopsis: "章",
        charCount: 0,
      };
      const scene = {
        id: "s1",
        parentId: "ch1",
        nodeType: "scene" as const,
        title: "S1",
        sortOrder: "a0",
        synopsis: "シーン1",
        charCount: 10,
      };

      mockTreeState.mockReturnValue({
        // @ts-expect-error stub
        nodes: [folder, scene],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);

      let refreshCount = 0;
      mockBuildSystemPrompt.mockImplementation((args) => {
        refreshCount++;
        const withMentions =
          args.mentionedScenes && args.mentionedScenes.length > 0;
        return {
          prompt: withMentions
            ? `mention付き-${refreshCount}`
            : `mentionなし-${refreshCount}`,
          totalTokens: 10,
          layers: [],
        };
      });

      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        chatScope: "project",
        scopeAnchorId: null,
        lastSystemPrompt: "",
        messages: [],
        includeBodies: false,
      });

      const result = await useChatStore
        .getState()
        .buildPromptForCopy("コピー用", { mentionedSceneIds: ["s1"] });

      // Copy 結果には mention 込みの prompt が乗る
      expect(result).toContain("[system]\nmention付き-");
      // しかし state 上の lastSystemPrompt は mention 抜きで巻き戻る
      // (次回 sendMessage が古い pin を吸わない)
      expect(useChatStore.getState().lastSystemPrompt).toMatch(/^mentionなし-/);
    });
  });

  // --- G21: inputPinnedEntryIds ---

  describe("setInputPinnedEntryIds", () => {
    it("stores IDs in state", () => {
      useChatStore.getState().setInputPinnedEntryIds(["a", "b"]);
      expect(useChatStore.getState().inputPinnedEntryIds).toEqual(["a", "b"]);
    });

    it("does not trigger refresh when IDs are unchanged", () => {
      useChatStore.setState({ inputPinnedEntryIds: ["a", "b"] });
      const spy = vi.spyOn(useChatStore.getState(), "refreshContextLayers");
      useChatStore.getState().setInputPinnedEntryIds(["b", "a"]); // same IDs, different order
      expect(spy).not.toHaveBeenCalled();
    });

    it("does not update when streaming", () => {
      useChatStore.setState({ isStreaming: true, inputPinnedEntryIds: [] });
      useChatStore.getState().setInputPinnedEntryIds(["x"]);
      expect(useChatStore.getState().inputPinnedEntryIds).toEqual([]);
    });
  });

  // --- Regression: global chat pin + mention should not duplicate summary ---

  describe("refreshContextLayers global chat pinned+mention dedup", () => {
    it("excludes mentioned child from DB-pinned parent's children and childrenContext", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const mockListCodex = vi.mocked(listCodexEntries);
      const mockListPinnedCodex = vi.mocked(chatApi.listPinnedCodexEntries);

      const now = new Date().toISOString();
      const parent = {
        id: "A",
        projectId: "proj-1",
        parentId: null,
        type: "character",
        name: "親A",
        aliases: null,
        excludedAliases: null,
        summary: "A-summary",
        content: "{}",
        icon: null,
        tagsCache: null,
        contextMode: "mentioned",
        childrenBudget: "compact",
        sourceChatMessageId: null,
        notes: null,
        createdAt: now,
        updatedAt: now,
      };
      const childX = {
        ...parent,
        id: "X",
        parentId: "A",
        name: "子X",
        summary: "X-summary",
      };
      const childY = {
        ...parent,
        id: "Y",
        parentId: "A",
        name: "子Y",
        summary: "Y-summary",
      };

      mockListCodex.mockResolvedValue([parent, childX, childY]);
      mockListPinnedCodex.mockResolvedValue([
        {
          ...parent,
          withChildren: true,
          pinnedType: "codex",
          pinSource: "manual",
        },
      ]);

      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        activeSessionId: "session-1",
        chatScope: "project",
        scopeAnchorId: null,
        inputPinnedEntryIds: ["X"],
      });

      await useChatStore.getState().refreshContextLayers();

      expect(mockBuildSystemPrompt).toHaveBeenCalled();
      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      const pinned = args?.pinnedCodexEntries ?? [];
      const parentCtx = pinned.find((p) => p.id === "A");
      const childCtx = pinned.find((p) => p.id === "X");

      expect(parentCtx).toBeDefined();
      expect(childCtx).toBeDefined();

      // A の children 配列に X が含まれてはならない（G21 pin されているため重複防止）
      expect(parentCtx?.children?.map((c) => c.id) ?? []).not.toContain("X");
      // A の childrenContext にも X-summary が含まれてはならない
      expect(parentCtx?.childrenContext ?? "").not.toContain("X-summary");
      // Y は依然として children/childrenContext に含まれるべき
      expect(parentCtx?.children?.map((c) => c.id) ?? []).toContain("Y");
      expect(parentCtx?.childrenContext ?? "").toContain("Y-summary");
    });
  });

  // --- Phase 2: folder scope での子シーン本文集約 ---

  describe("refreshContextLayers folder scope aggregation", () => {
    it("aggregates descendant scene bodies and detects codex from joined text", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockMatcher = vi.mocked(findMentionedEntriesAsync);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const folder = {
        id: "ch1",
        parentId: null,
        nodeType: "folder",
        title: "Chapter 1",
        sortOrder: "a0",
        synopsis: "章 outline",
        charCount: 0,
      };
      const sceneA = {
        id: "sA",
        parentId: "ch1",
        nodeType: "scene",
        title: "シーンA",
        sortOrder: "a0",
        synopsis: "Aのあらすじ",
        charCount: 100,
      };
      const sceneB = {
        id: "sB",
        parentId: "ch1",
        nodeType: "scene",
        title: "シーンB",
        sortOrder: "a1",
        synopsis: null,
        charCount: 100,
      };

      const codexEntry = {
        id: "char1",
        projectId: "proj-1",
        parentId: null,
        type: "character",
        name: "アリス",
        aliases: null,
        excludedAliases: null,
        summary: "ヒロイン",
        content: "{}",
        icon: null,
        tagsCache: null,
        contextMode: "mentioned",
        phaseLabel: null,
        notes: null,
        childrenBudget: "compact",
        sourceChatMessageId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用に nodes だけ持つ tree state を返す
        nodes: [folder, sceneA, sceneB],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([codexEntry]);
      mockLoadScene
        .mockResolvedValueOnce("シーンA の本文")
        .mockResolvedValueOnce("シーンB の本文");
      mockMatcher.mockResolvedValue([
        { id: "char1", name: "アリス", type: "character" },
      ]);

      useChatStore.setState({
        activeSceneId: "sA",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "folder",
        scopeAnchorId: "ch1",
        inputPinnedEntryIds: [],
        // Tier 1 を発火させるため明示的に includeBodies=true
        includeBodies: true,
      });

      mockBuildSystemPrompt.mockReturnValue({
        prompt: "p",
        totalTokens: 100,
        layers: [],
      });

      await useChatStore.getState().refreshContextLayers();

      // buildSystemPrompt が aggregated content と Chapter title で呼ばれている
      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      expect(args?.scene.title).toBe("Chapter 1");
      const content = args?.scene.content ?? "";
      // active scene には [current edit] マーカー、それ以外は素のタイトル
      expect(content).toContain("--- シーンA [current edit] ---");
      expect(content).toContain("--- シーンB ---");
      expect(content).toContain("シーンA の本文");
      expect(content).toContain("シーンB の本文");
      // 各シーンに synopsis が付く（sceneA のみ synopsis あり、sceneB は無いので
      // Synopsis 行は sceneA セクションだけに出る）
      expect(content).toContain("Synopsis: Aのあらすじ");
      // reading order (sortOrder) を維持: sceneA (a0) が sceneB (a1) より先
      expect(content.indexOf("シーンA")).toBeLessThan(
        content.indexOf("シーンB"),
      );

      // 検出された codex が detectedEntries に乗っている
      const state = useChatStore.getState();
      expect(state.detectedEntries.map((e) => e.id)).toEqual(["char1"]);
    });

    it("uses Tier 2 (synopsis-only aggregate) when includeBodies=false even within Tier 1 size", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockMatcher = vi.mocked(findMentionedEntriesAsync);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const folder = {
        id: "ch1",
        parentId: null,
        nodeType: "folder",
        title: "Small Chapter",
        sortOrder: "a0",
        synopsis: "outline",
        charCount: 0,
      };
      const sceneA = {
        id: "sA",
        parentId: "ch1",
        nodeType: "scene",
        title: "シーンA",
        sortOrder: "a0",
        synopsis: "Aのあらすじ",
        charCount: 100,
      };
      const sceneB = {
        id: "sB",
        parentId: "ch1",
        nodeType: "scene",
        title: "シーンB",
        sortOrder: "a1",
        synopsis: null,
        charCount: 100,
      };

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [folder, sceneA, sceneB],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockClear();
      mockMatcher.mockClear();
      mockMatcher.mockResolvedValue([]);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "p",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.setState({
        activeSceneId: "sA",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "folder",
        scopeAnchorId: "ch1",
        inputPinnedEntryIds: [],
        includeBodies: false, // eco mode 強制
      });

      await useChatStore.getState().refreshContextLayers();

      // 本文ロードは走らない
      expect(mockLoadScene).not.toHaveBeenCalled();
      // synopsis 集約 content が組み立てられている
      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      const content = args?.scene.content ?? "";
      expect(content).toContain("--- シーンA [current edit] ---");
      expect(content).toContain("Synopsis: Aのあらすじ");
      expect(content).toContain("--- シーンB ---");
      expect(content).toContain("(synopsis 未記入)");
      // eco モードのプロローグ
      expect(content).toContain("eco モード");
    });

    it("uses Tier 2 with a non-eco overflow note (not 'eco モード') when includeBodies=true but bodies exceed the size threshold", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockMatcher = vi.mocked(findMentionedEntriesAsync);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const folder = {
        id: "ch1",
        parentId: null,
        nodeType: "folder",
        title: "Big Chapter",
        sortOrder: "a0",
        synopsis: "outline",
        charCount: 0,
      };
      // シーン数は 2 (≤30) だが totalChars が 100_000 を超えるため Tier 1 から
      // overflow して Tier 2 に落ちる。シーン数は少ないので「シーン数が多いため」
      // 系の文言だと誤りになる経路を意図的に踏む。
      const sceneA = {
        id: "sA",
        parentId: "ch1",
        nodeType: "scene",
        title: "シーンA",
        sortOrder: "a0",
        synopsis: "Aのあらすじ",
        charCount: 60_000,
      };
      const sceneB = {
        id: "sB",
        parentId: "ch1",
        nodeType: "scene",
        title: "シーンB",
        sortOrder: "a1",
        synopsis: null,
        charCount: 60_000,
      };

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [folder, sceneA, sceneB],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockClear();
      mockMatcher.mockClear();
      mockMatcher.mockResolvedValue([]);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "p",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.setState({
        activeSceneId: "sA",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "folder",
        scopeAnchorId: "ch1",
        inputPinnedEntryIds: [],
        includeBodies: true, // eco は OFF。それでも overflow で Tier 2 に落ちる
      });

      await useChatStore.getState().refreshContextLayers();

      // overflow でも本文ロードは走らない (synopsis 集約)
      expect(mockLoadScene).not.toHaveBeenCalled();
      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      const content = args?.scene.content ?? "";
      // synopsis 集約として組み立てられている (Tier 2 に到達している証跡)
      expect(content).toContain("--- シーンA [current edit] ---");
      expect(content).toContain("Synopsis: Aのあらすじ");
      expect(content).toContain("(synopsis 未記入)");
      // eco モードではないので「eco モード」表記を出さない (本件の回帰 gate)
      expect(content).not.toContain("eco モード");
      // 代わりに本文省略理由を上限超過として伝える (本文が無いことはモデルに明示)
      expect(content).toContain("本文集約の上限を超えた");
      expect(content).toContain("本文は注入されていません");
    });

    it("Tier 2 folder: injects placed and unplaced beats into each scene part", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent, loadSceneFull, loadScenesFull } =
        await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockLoadSceneFull = vi.mocked(loadSceneFull);
      const mockLoadScenesFull = vi.mocked(loadScenesFull);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const beatDoc = (beatId: string, text: string) =>
        JSON.stringify({
          type: "doc",
          content: [
            {
              type: "sceneBeat",
              attrs: {
                id: beatId,
                beatType: "dialogue",
                pov: null,
                collapsed: false,
              },
              content: [{ type: "text", text }],
            },
          ],
        });
      const unplacedDoc = JSON.stringify([
        {
          id: "u1",
          beatType: "micro",
          pov: null,
          collapsed: false,
          content: [{ type: "text", text: "未配置ヒント" }],
        },
      ]);

      const folder = {
        id: "ch1",
        parentId: null,
        nodeType: "folder",
        title: "Chapter",
        sortOrder: "a0",
        synopsis: "outline",
        charCount: 0,
      };
      const sceneA = {
        id: "sA",
        parentId: "ch1",
        nodeType: "scene",
        title: "シーンA",
        sortOrder: "a0",
        synopsis: "Aのあらすじ",
        charCount: 100,
      };
      const sceneB = {
        id: "sB",
        parentId: "ch1",
        nodeType: "scene",
        title: "シーンB",
        sortOrder: "a1",
        synopsis: "Bのあらすじ",
        charCount: 100,
      };

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [folder, sceneA, sceneB],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockClear();
      mockLoadScenesFull.mockClear();
      mockLoadSceneFull.mockImplementation((id: string) => {
        if (id === "sA") {
          return Promise.resolve({
            content: beatDoc("b1", "シーンAのビート"),
            unplacedBeatsDoc: unplacedDoc,
          });
        }
        if (id === "sB") {
          return Promise.resolve({
            content: beatDoc("b2", "シーンBのビート"),
            unplacedBeatsDoc: "[]",
          });
        }
        return Promise.resolve({ content: "{}", unplacedBeatsDoc: "[]" });
      });
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "p",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.setState({
        activeSceneId: "sA",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "folder",
        scopeAnchorId: "ch1",
        inputPinnedEntryIds: [],
        includeBodies: false,
      });

      await useChatStore.getState().refreshContextLayers();

      expect(mockLoadScene).not.toHaveBeenCalled();
      const content =
        mockBuildSystemPrompt.mock.calls.at(-1)?.[0]?.scene.content ?? "";
      const partA = content.slice(
        content.indexOf("--- シーンA"),
        content.indexOf("--- シーンB"),
      );
      const partB = content.slice(content.indexOf("--- シーンB"));
      expect(partA).toContain("## このシーンの予定ビート");
      expect(partA).toMatch(/(^|\n)## このシーンの予定ビート/);
      expect(partA).toContain("Placed #1");
      expect(partA).toContain("シーンAのビート");
      expect(partA).toContain("Unplaced");
      expect(partA).toContain("未配置ヒント");
      expect(partB).toContain("## このシーンの予定ビート");
      expect(partB).toMatch(/(^|\n)## このシーンの予定ビート/);
      expect(partB).toContain("Placed #1");
      expect(partB).toContain("シーンBのビート");
      expect(partB).not.toContain("未配置ヒント");
      // descendant 数に関わらず本文取得は 1 バッチに畳まれる (N 往復回帰のガード)。
      expect(mockLoadScenesFull).toHaveBeenCalledTimes(1);
      expect(mockLoadScenesFull).toHaveBeenCalledWith(["sA", "sB"]);
    });

    it("Tier 2 folder: beat.injectIntoContext=false skips beats and loadSceneFull", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent, loadSceneFull } =
        await import("@/features/tree/api");
      const { useSettingsStore } =
        await import("@/features/settings/settingsStore");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockLoadSceneFull = vi.mocked(loadSceneFull);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const folder = {
        id: "ch1",
        parentId: null,
        nodeType: "folder",
        title: "Chapter",
        sortOrder: "a0",
        synopsis: null,
        charCount: 0,
      };
      const scene = {
        id: "s1",
        parentId: "ch1",
        nodeType: "scene",
        title: "S1",
        sortOrder: "a0",
        synopsis: "syn",
        charCount: 100,
      };

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [folder, scene],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockClear();
      useSettingsStore.setState((s) => ({
        cache: { ...s.cache, "beat.injectIntoContext": "false" },
      }));
      mockLoadSceneFull.mockClear();
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "p",
        totalTokens: 0,
        layers: [],
      });

      try {
        useChatStore.setState({
          activeSceneId: "s1",
          activeProjectId: "proj-1",
          chatScope: "folder",
          scopeAnchorId: "ch1",
          includeBodies: false,
        });

        await useChatStore.getState().refreshContextLayers();

        const content =
          mockBuildSystemPrompt.mock.calls.at(-1)?.[0]?.scene.content ?? "";
        expect(content).not.toContain("予定ビート");
        expect(mockLoadSceneFull.mock.calls.length).toBe(0);
      } finally {
        useSettingsStore.setState((s) => ({
          cache: { ...s.cache, "beat.injectIntoContext": "true" },
        }));
      }
    });

    it("Tier 2 folder: unplaced beats still inject when scene content is not PM-JSON", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneFull } = await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadSceneFull = vi.mocked(loadSceneFull);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const folder = {
        id: "ch1",
        parentId: null,
        nodeType: "folder",
        title: "Chapter",
        sortOrder: "a0",
        synopsis: null,
        charCount: 0,
      };
      const scene = {
        id: "s1",
        parentId: "ch1",
        nodeType: "scene",
        title: "Legacy",
        sortOrder: "a0",
        synopsis: null,
        charCount: 100,
      };

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [folder, scene],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadSceneFull.mockResolvedValue({
        content: "<p>old html</p>",
        unplacedBeatsDoc: JSON.stringify([
          {
            id: "u1",
            beatType: "micro",
            pov: null,
            collapsed: false,
            content: [{ type: "text", text: "レガシー未配置" }],
          },
        ]),
      });
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "p",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.setState({
        activeSceneId: "s1",
        activeProjectId: "proj-1",
        chatScope: "folder",
        scopeAnchorId: "ch1",
        includeBodies: false,
      });

      await useChatStore.getState().refreshContextLayers();

      const content =
        mockBuildSystemPrompt.mock.calls.at(-1)?.[0]?.scene.content ?? "";
      expect(content).toContain("Unplaced");
      expect(content).toContain("レガシー未配置");
      expect(content).not.toContain("Placed #");
    });

    it("falls back to Tier 3 (outline only) when scene count exceeds Tier 2 threshold (200)", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockMatcher = vi.mocked(findMentionedEntriesAsync);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const folder = {
        id: "ch1",
        parentId: null,
        nodeType: "folder",
        title: "Mega Act",
        sortOrder: "a0",
        synopsis: "outline",
        charCount: 0,
      };
      // 201 個のシーン = Tier 2 (200) を超える
      const scenes = Array.from({ length: 201 }, (_, i) => ({
        id: `s${i}`,
        parentId: "ch1",
        nodeType: "scene" as const,
        title: `S${i}`,
        sortOrder: `a${i.toString(36)}`,
        synopsis: null,
        charCount: 100,
      }));

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [folder, ...scenes],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockClear();
      mockMatcher.mockClear();
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "p",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "folder",
        scopeAnchorId: "ch1",
        inputPinnedEntryIds: [],
        includeBodies: true, // Tier 1 願望でも閾値超過で Tier 3 に落ちる
      });

      await useChatStore.getState().refreshContextLayers();

      // 本文 load も matcher も呼ばれない
      expect(mockLoadScene).not.toHaveBeenCalled();
      expect(mockMatcher).not.toHaveBeenCalled();
      // buildSystemPrompt は scene.content 空で呼ばれている (outline only)
      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      expect(args?.scene.content).toBe("");
    });

    it("drops from Tier 1 to Tier 2 when scene count exceeds Tier 1 threshold (30) but within Tier 2 (200)", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockMatcher = vi.mocked(findMentionedEntriesAsync);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const folder = {
        id: "ch1",
        parentId: null,
        nodeType: "folder",
        title: "Big Chapter",
        sortOrder: "a0",
        synopsis: "outline",
        charCount: 0,
      };
      const scenes = Array.from({ length: 31 }, (_, i) => ({
        id: `s${i}`,
        parentId: "ch1",
        nodeType: "scene" as const,
        title: `S${i}`,
        sortOrder: `a${i.toString(36)}`,
        synopsis: null,
        charCount: 100,
      }));

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [folder, ...scenes],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockClear();
      mockMatcher.mockClear();
      mockMatcher.mockResolvedValue([]);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "p",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "folder",
        scopeAnchorId: "ch1",
        inputPinnedEntryIds: [],
        // includeBodies=true でも 31 シーンは Tier 1 を超えるので Tier 2 へ降りる
        includeBodies: true,
      });

      await useChatStore.getState().refreshContextLayers();

      // Tier 2 では本文ロードは走らない
      expect(mockLoadScene).not.toHaveBeenCalled();
      // ただし synopsis 集約で content は組まれる
      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      const content = args?.scene.content ?? "";
      expect(content).toContain("--- S0 ---");
      expect(content).toContain("(synopsis 未記入)");
    });

    it("applies eco mode for scene scope by blanking sceneCtx.content when includeBodies=false", async () => {
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent, getNode } = await import("@/features/tree/api");

      const mockTreeState = vi.mocked(useTreeStore.getState);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockGetNode = vi.mocked(getNode);

      mockTreeState.mockReturnValue({
        nodes: [
          {
            id: "scene-1",
            parentId: null,
            nodeType: "scene",
            title: "テストシーン",
            sortOrder: "a0",
            synopsis: "シーンの要約",
            charCount: 1000,
          },
        ],
        projectId: "proj-1",
      } as never);
      mockGetNode.mockResolvedValue({
        id: "scene-1",
        title: "テストシーン",
        synopsis: "シーンの要約",
      } as never);
      mockLoadScene.mockClear();
      mockLoadScene.mockResolvedValue("これは長いシーン本文");
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "p",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.setState({
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "scene",
        scopeAnchorId: null,
        inputPinnedEntryIds: [],
        includeBodies: false, // scene scope eco
      });

      await useChatStore.getState().refreshContextLayers();

      // fetchSceneContext は呼ばれるが、buildSceneContextPrompt 内で sceneCtx.content
      // を空にしてから buildSystemPrompt に渡される ⇒ scene.content === ""
      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      expect(args?.scene.content).toBe("");
      // 一方 synopsis は残り、scene.title も残る
      expect(args?.scene.title).toBe("テストシーン");
    });
  });

  describe("refreshContextLayers project scope aggregation", () => {
    function makeScene(
      id: string,
      parentId: string,
      title: string,
      sortOrder: string,
      synopsis: string | null = null,
      charCount = 100,
    ) {
      return {
        id,
        parentId,
        nodeType: "scene" as const,
        title,
        sortOrder,
        synopsis,
        charCount,
      };
    }

    function makeFolder(
      id: string,
      sortOrder: string,
      synopsis: string | null = null,
      title = id,
    ) {
      return {
        id,
        parentId: null,
        nodeType: "folder" as const,
        title,
        sortOrder,
        synopsis,
        charCount: 0,
      };
    }

    it("Tier 1: aggregates all project scenes with bodies when includeBodies=true", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const f1 = makeFolder("act1", "a0", null, "Act 1");
      const f2 = makeFolder("act2", "a1", null, "Act 2");
      const scenes = [
        ...Array.from({ length: 5 }, (_, i) =>
          makeScene(`s1-${i}`, "act1", `A${i}`, `a${i}`),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          makeScene(`s2-${i}`, "act2", `B${i}`, `a${i}`),
        ),
      ];

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [f1, f2, ...scenes],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockImplementation((id) => Promise.resolve(`body:${id}`));
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "project-tier1-prompt",
        totalTokens: 100,
        layers: [],
      });

      useChatStore.getState().setChatScope("project");
      useChatStore.setState({
        activeSceneId: "s1-0",
        activeProjectId: "proj-1",
        includeBodies: true,
      });

      await useChatStore.getState().refreshContextLayers();

      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      expect(args?.scene.title).toBe("テストプロジェクト");
      const content = args?.scene.content ?? "";
      expect(content).toContain("=== Act 1 ===");
      expect(content).toContain("=== Act 2 ===");
      expect(content.indexOf("=== Act 1 ===")).toBeLessThan(
        content.indexOf("--- A0"),
      );
      expect(content.indexOf("=== Act 2 ===")).toBeLessThan(
        content.indexOf("--- B0"),
      );
      expect(content).toContain("--- A0 [current edit] ---");
      expect(content).toContain("body:s1-0");
      expect(content).toContain("--- B0 ---");
      expect(useChatStore.getState().lastSystemPrompt).toBe(
        "project-tier1-prompt",
      );
    });

    it("Tier 2: nests scenes under folder outline headers", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const act = {
        ...makeFolder("act1", "a0", "第一幕の骨格", "Act 1"),
        parentId: null,
      };
      const chapter = {
        ...makeFolder("ch1", "a0", "第3章の意図", "Chapter 3"),
        parentId: "act1",
      };
      const scene = makeScene("s1", "ch1", "クライマックス", "a0", "決戦");

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [act, chapter, scene],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockClear();
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "nested-prompt",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.getState().setChatScope("project");
      useChatStore.setState({
        activeProjectId: "proj-1",
        includeBodies: false,
      });

      await useChatStore.getState().refreshContextLayers();

      const content =
        mockBuildSystemPrompt.mock.calls.at(-1)?.[0]?.scene.content ?? "";
      expect(content).toContain("=== Act 1 ===");
      expect(content).toContain("Outline: 第一幕の骨格");
      expect(content).toContain("=== Chapter 3 ===");
      expect(content).toContain("Outline: 第3章の意図");
      expect(content.indexOf("=== Chapter 3 ===")).toBeLessThan(
        content.indexOf("--- クライマックス"),
      );
      expect(content).toContain("Synopsis: 決戦");
    });

    it("Tier 2: synopsis-only aggregate includes root-level scenes", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockMatcher = vi.mocked(findMentionedEntriesAsync);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const rootScene = {
        ...makeScene("root", "ch", "Opening", "a0", "ルートのあらすじ"),
        parentId: null,
      };

      const folder = makeFolder("ch", "a1", null, "Chapter");
      const folderScenes = Array.from({ length: 49 }, (_, i) =>
        makeScene(
          `s${i}`,
          "ch",
          `S${i}`,
          `a${i.toString(36)}`,
          i === 0 ? "最初のシーン" : null,
        ),
      );

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [rootScene, folder, ...folderScenes],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockClear();
      mockMatcher.mockClear();
      mockMatcher.mockResolvedValue([]);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "project-tier2-prompt",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.getState().setChatScope("project");
      useChatStore.setState({
        activeSceneId: "root",
        activeProjectId: "proj-1",
        includeBodies: false,
      });

      await useChatStore.getState().refreshContextLayers();

      expect(mockLoadScene).not.toHaveBeenCalled();
      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      const content = args?.scene.content ?? "";
      expect(content).toContain("--- Opening [current edit] ---");
      expect(content).toContain("Synopsis: ルートのあらすじ");
      expect(content.indexOf("--- Opening")).toBeLessThan(
        content.indexOf("=== Chapter ==="),
      );
      expect(content).toContain("Synopsis: 最初のシーン");
      expect(content).toContain("(synopsis 未記入)");
      expect(content).toContain("eco モード");
      expect(useChatStore.getState().lastSystemPrompt).toBe(
        "project-tier2-prompt",
      );
    });

    it("Tier 2 project-grouped: beat sections appear under each scene within folder hierarchy", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent, loadSceneFull } =
        await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockLoadSceneFull = vi.mocked(loadSceneFull);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const beatDoc = JSON.stringify({
        type: "doc",
        content: [
          {
            type: "sceneBeat",
            attrs: {
              id: "b1",
              beatType: "dialogue",
              pov: null,
              collapsed: false,
            },
            content: [{ type: "text", text: "対決ビート" }],
          },
        ],
      });

      const act = {
        ...makeFolder("act1", "a0", "第一幕", "Act 1"),
        parentId: null,
      };
      const chapter = {
        ...makeFolder("ch1", "a0", "第3章", "Chapter 3"),
        parentId: "act1",
      };
      const scene = makeScene("s1", "ch1", "クライマックス", "a0", "決戦");

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [act, chapter, scene],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockClear();
      mockLoadSceneFull.mockResolvedValue({
        content: beatDoc,
        unplacedBeatsDoc: "[]",
      });
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "nested-beats-prompt",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.getState().setChatScope("project");
      useChatStore.setState({
        activeProjectId: "proj-1",
        includeBodies: false,
      });

      await useChatStore.getState().refreshContextLayers();

      const content =
        mockBuildSystemPrompt.mock.calls.at(-1)?.[0]?.scene.content ?? "";
      const folderIdx = content.indexOf("=== Chapter 3 ===");
      const sceneIdx = content.indexOf("--- クライマックス");
      const beatsIdx = content.indexOf("## このシーンの予定ビート");
      expect(folderIdx).toBeGreaterThanOrEqual(0);
      expect(sceneIdx).toBeGreaterThan(folderIdx);
      expect(beatsIdx).toBeGreaterThan(sceneIdx);
      expect(content).toContain("Placed #1");
      expect(content).toContain("対決ビート");
    });

    it("Tier 3: outline only when scene count exceeds 200", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const f1 = makeFolder("act1", "a0", "Act one outline", "Act 1");
      const f2 = makeFolder("act2", "a1", "Act two outline", "Act 2");
      const scenes = Array.from({ length: 201 }, (_, i) =>
        makeScene(`s${i}`, "act1", `S${i}`, `a${i.toString(36)}`),
      );

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [f1, f2, ...scenes],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockClear();
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "project-tier3-prompt",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.getState().setChatScope("project");
      useChatStore.setState({
        activeProjectId: "proj-1",
        includeBodies: false,
      });

      await useChatStore.getState().refreshContextLayers();

      expect(mockLoadScene).not.toHaveBeenCalled();
      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      const content = args?.scene.content ?? "";
      expect(content).toContain("=== Act 1 ===");
      expect(content).toContain("Outline: Act one outline");
      expect(content).toContain("=== Act 2 ===");
      expect(content).toContain("Outline: Act two outline");
      expect(content).not.toContain("--- S0 ---");
      expect(args?.chapterOutlines).toBeUndefined();
    });

    it("agent mode: pull 委譲 — Tier 2 を outline only に落とし synopsis を push しない", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockMatcher = vi.mocked(findMentionedEntriesAsync);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const folder = makeFolder("ch1", "a0", "第3章の意図", "Chapter 3");
      const scene = makeScene("s1", "ch1", "クライマックス", "a0", "決戦");

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [folder, scene],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockClear();
      mockMatcher.mockClear();
      mockMatcher.mockResolvedValue([]);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "project-agent-pull-prompt",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.getState().setChatScope("project");
      useChatStore.setState({
        activeProjectId: "proj-1",
        includeBodies: false,
        agentMode: true,
      });

      await useChatStore.getState().refreshContextLayers();

      // 本文ロードは走らない（outline only）
      expect(mockLoadScene).not.toHaveBeenCalled();
      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      const content = args?.scene.content ?? "";
      // folder outline は残る
      expect(content).toContain("=== Chapter 3 ===");
      expect(content).toContain("Outline: 第3章の意図");
      // 個別シーンの synopsis は push しない
      expect(content).not.toContain("Synopsis: 決戦");
      expect(content).not.toContain("--- クライマックス");
      expect(content).not.toContain("eco モード");
      // pull 取得ツールを案内する
      expect(content).toContain("get_chapter_summaries");
      // agentMode は buildSystemPrompt にも反映される
      expect(args?.agentMode).toBe(true);
    });

    it("agent mode: 明示 includeBodies=true の小規模プロジェクトは Tier 1 本文を維持する", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const f1 = makeFolder("act1", "a0", null, "Act 1");
      const scenes = Array.from({ length: 3 }, (_, i) =>
        makeScene(`s${i}`, "act1", `A${i}`, `a${i}`),
      );

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [f1, ...scenes],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockImplementation((id) => Promise.resolve(`body:${id}`));
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "project-agent-tier1-prompt",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.getState().setChatScope("project");
      useChatStore.setState({
        activeProjectId: "proj-1",
        includeBodies: true,
        agentMode: true,
      });

      await useChatStore.getState().refreshContextLayers();

      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      const content = args?.scene.content ?? "";
      // 明示的な本文要求は agent mode でも尊重し、pull 委譲しない
      expect(content).toContain("body:s0");
      expect(content).toContain("--- A0");
      expect(content).not.toContain("get_chapter_summaries");
    });

    it("agent mode + CLI provider: ツール無しなので pull 委譲せず全 synopsis を push する", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");
      const { useAiSettingsStore } = await import("./store");
      const { DEFAULT_AI_SETTINGS } = await import("./types");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockMatcher = vi.mocked(findMentionedEntriesAsync);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const folder = makeFolder("ch1", "a0", "第3章の意図", "Chapter 3");
      const scene = makeScene("s1", "ch1", "クライマックス", "a0", "決戦");

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [folder, scene],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockClear();
      mockMatcher.mockClear();
      mockMatcher.mockResolvedValue([]);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "project-cli-prompt",
        totalTokens: 0,
        layers: [],
      });

      // provider=CLI: ツールループが走らないので pull 委譲は無効化される。
      useAiSettingsStore.setState({
        settings: { ...DEFAULT_AI_SETTINGS, provider: "cli" },
      });
      try {
        useChatStore.getState().setChatScope("project");
        useChatStore.setState({
          activeProjectId: "proj-1",
          includeBodies: false,
          agentMode: true,
        });

        await useChatStore.getState().refreshContextLayers();

        const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
        const content = args?.scene.content ?? "";
        // CLI では agent mode でも従来どおり全 synopsis を push する（回帰 gate）
        expect(content).toContain("Synopsis: 決戦");
        expect(content).toContain("eco モード");
        expect(content).not.toContain("get_chapter_summaries");
      } finally {
        // 実ストアなので後続テストへ provider が漏れないよう戻す。
        useAiSettingsStore.setState({ settings: null });
      }
    });

    it("empty project: no aggregated scene content", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [makeFolder("empty", "a0")],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "empty-project-prompt",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.getState().setChatScope("project");
      useChatStore.setState({ activeProjectId: "proj-1" });

      await useChatStore.getState().refreshContextLayers();

      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      expect(args?.scene.content).toContain("=== empty ===");
      expect(useChatStore.getState().lastSystemPrompt).toBe(
        "empty-project-prompt",
      );
    });

    it("Tier 3: top-level scenes get a pseudo-group with title rows", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const f1 = makeFolder("act1", "a1", "Act one outline", "Act 1");
      const topLevelScenes = [
        makeScene("root-s0", "" as unknown as string, "Root Zero", "a0"),
        makeScene("root-s1", "" as unknown as string, "Root One", "a2"),
      ].map((s) => ({ ...s, parentId: null }));
      const foldered = Array.from({ length: 200 }, (_, i) =>
        makeScene(`s${i}`, "act1", `S${i}`, `a${i.toString(36)}`),
      );

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [f1, ...topLevelScenes, ...foldered],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockClear();
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "project-tier3-toplevel",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.getState().setChatScope("project");
      useChatStore.setState({
        activeSceneId: "root-s0",
        activeProjectId: "proj-1",
        includeBodies: false,
      });

      await useChatStore.getState().refreshContextLayers();

      expect(mockLoadScene).not.toHaveBeenCalled();
      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      const content = args?.scene.content ?? "";
      expect(content).toContain("=== (top level) ===");
      expect(content).toContain("- Root Zero [current edit]");
      expect(content).toContain("- Root One");
      expect(content).toContain("=== Act 1 ===");
      expect(content).toContain("Outline: Act one outline");
      // Tier 3 では nested scene 個別の synopsis 行は出ない
      expect(content).not.toContain("--- S0 ---");
    });

    it("completely empty tree (no nodes) returns empty scene", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      mockTreeState.mockReturnValue({
        nodes: [],
        projectId: "proj-1",
      } as unknown as ReturnType<typeof useTreeStore.getState>);
      mockListCodex.mockResolvedValue([]);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "empty-tree-prompt",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.getState().setChatScope("project");
      useChatStore.setState({ activeProjectId: "proj-1" });

      await useChatStore.getState().refreshContextLayers();

      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      expect(args?.scene.id).toBe("");
      expect(args?.scene.title).toBe("");
      expect(args?.scene.content).toBe("");
    });

    it("Tier 1: single scene load failure does not kill the aggregate", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntries);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockTreeState = vi.mocked(useTreeStore.getState);

      const f1 = makeFolder("act1", "a0", null, "Act 1");
      const scenes = Array.from({ length: 3 }, (_, i) =>
        makeScene(`s${i}`, "act1", `S${i}`, `a${i}`),
      );

      mockTreeState.mockReturnValue({
        // @ts-expect-error テスト用 stub
        nodes: [f1, ...scenes],
        projectId: "proj-1",
      });
      mockListCodex.mockResolvedValue([]);
      mockLoadScene.mockImplementation((id) =>
        id === "s1"
          ? Promise.reject(new Error("boom"))
          : Promise.resolve(`body:${id}`),
      );
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "project-tier1-partial-fail",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.getState().setChatScope("project");
      useChatStore.setState({
        activeProjectId: "proj-1",
        includeBodies: true,
      });

      await useChatStore.getState().refreshContextLayers();

      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      const content = args?.scene.content ?? "";
      // 失敗した s1 は本文空、残り s0/s2 は本文込みで生き残る
      expect(content).toContain("body:s0");
      expect(content).toContain("body:s2");
      expect(content).toContain("--- S1 ---");
      expect(content).not.toContain("body:s1");
      expect(useChatStore.getState().lastSystemPrompt).toBe(
        "project-tier1-partial-fail",
      );
    });
  });

  describe("setChatScope codex", () => {
    it("sets codex scope with anchor and includeBodies=false", () => {
      useChatStore.getState().setChatScope("codex", "codex-hero");
      const s = useChatStore.getState();
      expect(s.chatScope).toBe("codex");
      expect(s.scopeAnchorId).toBe("codex-hero");
      expect(s.includeBodies).toBe(false);
    });

    it("falls back to scene when codex anchor is missing", () => {
      useChatStore.getState().setChatScope("codex");
      const s = useChatStore.getState();
      expect(s.chatScope).toBe("scene");
      expect(s.includeBodies).toBe(true);
    });

    it("loadSessions passes codexAnchorId to chatApi", async () => {
      mockListSessions.mockResolvedValueOnce([]);
      await useChatStore.getState().loadSessions(undefined, "codex-1");
      expect(mockListSessions).toHaveBeenCalledWith(undefined, "codex-1");
    });

    it("ensureSession creates session with codexAnchorId in codex scope", async () => {
      mockCreateSession.mockResolvedValueOnce({
        ...session1,
        id: "new-codex-session",
        nodeId: null,
        codexAnchorId: "codex-hero",
      });
      useChatStore.setState({
        activeSessionId: null,
        chatScope: "codex",
        scopeAnchorId: "codex-hero",
        activeProjectId: "proj-1",
      });
      const id = await useChatStore.getState().ensureSession();
      expect(mockCreateSession).toHaveBeenCalledWith(
        "proj-1",
        "New session",
        undefined,
        "codex-hero",
      );
      expect(id).toBe("new-codex-session");
    });

    it("setActiveSceneId keeps codex scope session anchor", async () => {
      useChatStore.setState({
        chatScope: "codex",
        scopeAnchorId: "codex-hero",
        activeSessionId: "session-codex",
        activeSceneId: "scene-old",
      });
      useChatStore.getState().setActiveSceneId("scene-new");
      const s = useChatStore.getState();
      expect(s.chatScope).toBe("codex");
      expect(s.scopeAnchorId).toBe("codex-hero");
      expect(s.activeSessionId).toBe("session-codex");
    });
  });

  describe("setIncludeMapBoard (Map overlay)", () => {
    it("ON にすると includeMapBoard が true、boardId が反映される", () => {
      useChatStore
        .getState()
        .setIncludeMapBoard(true, { source: "auto", boardId: "b1" });
      const s = useChatStore.getState();
      expect(s.includeMapBoard).toBe(true);
      expect(s.mapBoardId).toBe("b1");
    });

    it("OFF にすると mapBoardId も自動的に null クリアされる (stale 防止)", () => {
      useChatStore.setState({ includeMapBoard: true, mapBoardId: "b1" });
      useChatStore.getState().setIncludeMapBoard(false);
      const s = useChatStore.getState();
      expect(s.includeMapBoard).toBe(false);
      expect(s.mapBoardId).toBeNull();
    });

    it("ON 時に boardId 未指定なら既存の mapBoardId を維持", () => {
      useChatStore.setState({ includeMapBoard: false, mapBoardId: "b-prev" });
      useChatStore.getState().setIncludeMapBoard(true);
      const s = useChatStore.getState();
      expect(s.includeMapBoard).toBe(true);
      expect(s.mapBoardId).toBe("b-prev");
    });

    it("auto と user の両方とも state を更新する (override セマンティクスなし)", () => {
      useChatStore.setState({ includeMapBoard: true, mapBoardId: "b1" });
      useChatStore.getState().setIncludeMapBoard(false, { source: "user" });
      expect(useChatStore.getState().includeMapBoard).toBe(false);
      useChatStore
        .getState()
        .setIncludeMapBoard(true, { source: "auto", boardId: "b2" });
      const s = useChatStore.getState();
      expect(s.includeMapBoard).toBe(true);
      expect(s.mapBoardId).toBe("b2");
    });
  });
});
