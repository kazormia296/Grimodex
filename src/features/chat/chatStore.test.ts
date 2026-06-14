import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useChatStore, contextPromptKey } from "./chatStore";
import { useAiSettingsStore, DEFAULT_AI_SETTINGS } from "./store";
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
  saveMessagePrompt: vi.fn(() => Promise.resolve()),
  getMessagePrompt: vi.fn(() => Promise.resolve(null)),
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

vi.mock("@/features/snippets/api", () => ({
  getSnippet: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("@/features/codex/codexMatcher", () => ({
  findMentionedEntries: vi.fn(() => []),
}));

// phase/detail API は drizzle (db_execute IPC) 直なので test 環境では失敗する。
// 「フェーズ・詳細なし」の素通り挙動をモックで再現する。
vi.mock("@/features/codex/phaseApi", () => ({
  listPhasesByEntryIds: vi.fn(() => Promise.resolve([])),
  listDetailOverridesByPhaseIds: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/features/codex/detailApi", () => ({
  listContextDetailsByEntryIds: vi.fn(() => Promise.resolve([])),
  listRawDetailValuesByEntryIds: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/features/codex/rustMatcher", () => ({
  findMentionedEntriesAsync: vi.fn(() => Promise.resolve([])),
}));

// semantic 検索は drizzle/IPC 直なので test では既定で空。buildPreviewPrompt の
// テストでだけ mockResolvedValueOnce でヒットを差し込む。
vi.mock("@/features/semantic-search/api", () => ({
  semanticSearch: vi.fn(() => Promise.resolve([])),
  semanticIndexStatus: vi.fn(() => Promise.resolve(null)),
  semanticReindexAll: vi.fn(() => Promise.resolve(0)),
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
    // スコープ/プロンプトキーはテスト間で漏れると stale 判定や copy 経路の
    // 分岐が前のテストの構成で動いてしまうため必ず初期化する
    chatScope: "scene",
    scopeAnchorId: null,
    lastSystemPromptKey: null,
    // prefix cache バッジ系も毎テスト初期化する。これらは resetStore で戻さないと
    // sendMessage 冒頭のモデル一致判定が前テストの残留値で分岐し、後続テストへ
    // 漏れる (cache badge テスト群の afterEach だけに依存させない)。
    _lastCachedModel: null,
    cacheInvalidatedReason: null,
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
  snippetAnchorId: null,
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
  snippetAnchorId: null,
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
    // プロンプトプレビューの入力ドラフト DI をテスト間でリセット
    useChatStore.getState().registerInputDraftProvider(null);
  });

  // --- Session management tests ---

  describe("loadSessions", () => {
    it("loads sessions for a scene", async () => {
      mockListSessions.mockResolvedValueOnce([session1, session2]);

      await useChatStore.getState().loadSessions("scene-1");

      const state = useChatStore.getState();
      expect(state.sessions).toHaveLength(2);
      expect(mockListSessions).toHaveBeenCalledWith(
        "proj-1",
        "scene-1",
        undefined,
        undefined,
      );
    });

    it("loads all sessions when no nodeId given", async () => {
      mockListSessions.mockResolvedValueOnce([session1]);

      await useChatStore.getState().loadSessions();

      expect(mockListSessions).toHaveBeenCalledWith(
        "proj-1",
        undefined,
        undefined,
        undefined,
      );
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

  describe("cacheInvalidatedReason (prefix cache rebuilt badge)", () => {
    afterEach(() => {
      // モデル / バッジ state は resetStore が触らないため、テスト間で漏れると
      // 後続 send 系テストの分岐に影響する。明示的に初期状態へ戻す。
      useAiSettingsStore.setState({ settings: null });
      useChatStore.setState({
        _lastCachedModel: null,
        cacheInvalidatedReason: null,
      });
    });

    it("flags 'model' and keeps it through the turn when the model changed since last send", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "openrouter",
          model: "model-B",
        },
      });
      useChatStore.setState({
        _lastCachedModel: "model-A",
        cacheInvalidatedReason: null,
      });
      mockStreamResponse("ok");

      await useChatStore.getState().sendMessage("テスト");

      // 以前は scene 経路のコンテキスト再構築 set() が同一ターン内で null に
      // 戻していたため scene 送信ではバッジが一切見えなかった。クリアを冒頭へ
      // 一元化したのでバッジは自分のターンを生き残る。
      expect(useChatStore.getState().cacheInvalidatedReason).toBe("model");
      expect(useChatStore.getState()._lastCachedModel).toBe("model-B");
    });

    it("clears a stale badge on the next send when the model is unchanged", async () => {
      // バグ再現: agent / RAG / global 経路には後段クリアが無く、モデル変更後に
      // 立てたバッジが同一モデルで送り続けても消えなかった。冒頭の一致判定で
      // 消灯を一元化したので、同一モデルの次送信で必ず消える。
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "openrouter",
          model: "model-A",
        },
      });
      useChatStore.setState({
        _lastCachedModel: "model-A",
        cacheInvalidatedReason: "model",
      });
      mockStreamResponse("ok");

      await useChatStore.getState().sendMessage("テスト");

      expect(useChatStore.getState().cacheInvalidatedReason).toBeNull();
    });

    it("does not flag when the current model is empty (no model selected)", async () => {
      // プロバイダチップ再クリック等で model が "" になった送信では、キャッシュの
      // 概念が無いのでバッジを立てない (誤点灯防止)。
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "openrouter",
          model: "",
        },
      });
      useChatStore.setState({
        _lastCachedModel: "model-A",
        cacheInvalidatedReason: null,
      });
      mockStreamResponse("ok");

      await useChatStore.getState().sendMessage("テスト");

      expect(useChatStore.getState().cacheInvalidatedReason).toBeNull();
    });

    it("clears a stale badge on a non-scene (global) send where the old in-turn clear never ran", async () => {
      // 本バグの本丸: scene 以外のスコープ (project/folder/codex/snippet) は
      // 旧コードの唯一のクリア箇所 (scene コンテキスト再構築 set()) を通らず、
      // バッジが居座り続けた。冒頭一元化が non-scene 経路でも効くことを直接 gate
      // する (scene 経路だけの 3 テストでは本丸経路に網がかからないため)。
      useChatStore.setState({
        activeSceneId: "",
        chatScope: "project",
        scopeAnchorId: null,
        lastSystemPrompt: "フォールバックプロンプト",
        _lastCachedModel: "model-A",
        cacheInvalidatedReason: "model",
      });
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "openrouter",
          model: "model-A",
        },
      });
      mockStreamResponse("ok");

      await useChatStore.getState().sendMessage("テスト");

      expect(useChatStore.getState().cacheInvalidatedReason).toBeNull();
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

    it("excludes scene body from the actual send when includeBodies=false (eco)", async () => {
      // refreshContextLayers だけでなく実送信でも本文が除外されること
      // (UI 表示と送信内容の一致)。
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "p",
        totalTokens: 10,
        layers: [],
      });
      mockStreamResponse("回答");
      useChatStore.setState({ includeBodies: false });

      await useChatStore.getState().sendMessage("質問");

      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      expect(args?.scene.content).toBe("");
    });

    it("passes volatileTail through to sendChatMessageStream", async () => {
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "p",
        totalTokens: 10,
        layers: [],
        cacheSegments: ["seg1"],
        volatileTail: "L5 要約",
      });
      mockStreamResponse("回答");

      await useChatStore.getState().sendMessage("質問");

      const callArgs = mockSendChatMessageStream.mock.calls[0];
      // (messages, thinking, callbacks, systemCacheSegments, apiVariant, systemVolatileTail)
      expect(callArgs[3]).toEqual(["seg1"]);
      expect(callArgs[5]).toBe("L5 要約");
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
      // 空プロンプトは送信前に同期 refresh を試みる（B2: スコープ切替直後の
      // 即送信レース対策）。再構築しても空なら従来どおり system 無しで送る。
      mockBuildSystemPrompt.mockReturnValueOnce({
        prompt: "",
        totalTokens: 0,
        layers: [],
      });
      mockStreamResponse("回答");

      await useChatStore.getState().sendMessage("テスト");

      const passedMessages = mockSendChatMessageStream.mock.calls[0][0];
      expect(passedMessages[0].role).toBe("user");
    });

    // B2 回帰ガード: スコープ切替直後の即送信は、前のスコープ構成で組まれた
    // lastSystemPrompt（stale）を流用せず、同期的に再構築してから送る。
    it("sendMessage rebuilds when lastSystemPrompt was built for a different scope", async () => {
      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        activeSessionId: "session-1",
        chatScope: "project",
        scopeAnchorId: null,
        lastSystemPrompt: "OLD PROMPT (scene scope)",
        lastSystemPromptKey: contextPromptKey({
          chatScope: "scene",
          scopeAnchorId: null,
          activeSceneId: "old-scene",
          activeSessionId: "session-1",
        }),
        includeMapBoard: false,
        mapBoardId: null,
      });
      mockBuildSystemPrompt.mockReturnValueOnce({
        prompt: "NEW PROMPT (project scope)",
        totalTokens: 0,
        layers: [],
      });
      mockStreamResponse("回答");

      await useChatStore.getState().sendMessage("テスト");

      const passedMessages = mockSendChatMessageStream.mock.calls[0][0];
      expect(passedMessages[0].role).toBe("system");
      expect(passedMessages[0].content).toBe("NEW PROMPT (project scope)");
    });

    it("sendMessage reuses lastSystemPrompt built for the current scope (no rebuild)", async () => {
      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        activeSessionId: "session-1",
        chatScope: "project",
        scopeAnchorId: null,
        lastSystemPrompt: "CURRENT PROMPT",
        includeMapBoard: false,
        mapBoardId: null,
      });
      useChatStore.setState({
        lastSystemPromptKey: contextPromptKey(useChatStore.getState()),
      });
      mockStreamResponse("回答");

      await useChatStore.getState().sendMessage("テスト");

      const passedMessages = mockSendChatMessageStream.mock.calls[0][0];
      expect(passedMessages[0].role).toBe("system");
      expect(passedMessages[0].content).toBe("CURRENT PROMPT");
      // 構成が一致しているので再構築は走らない
      expect(mockBuildSystemPrompt).not.toHaveBeenCalled();
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

    it("buildPromptForCopy scene スコープ: 入力を seed に related_scenes を含め、eco で本文を空にする", async () => {
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { getNode, loadSceneContent } = await import("@/features/tree/api");
      const { semanticSearch } = await import("@/features/semantic-search/api");
      const mockSearch = vi.mocked(semanticSearch);
      const mockTreeState = vi.mocked(useTreeStore.getState);
      mockTreeState.mockReturnValue({
        nodes: [
          {
            id: "scene-1",
            parentId: null,
            nodeType: "scene",
            title: "テストシーン",
            sortOrder: "a0",
            synopsis: "要約",
            charCount: 100,
          },
        ],
        projectId: "proj-1",
      } as never);
      vi.mocked(getNode).mockResolvedValue({
        id: "scene-1",
        title: "テストシーン",
        synopsis: "要約",
      } as never);
      vi.mocked(loadSceneContent).mockResolvedValue(
        "これは長いシーン本文" as never,
      );
      mockSearch.mockResolvedValueOnce([
        {
          sceneId: "other-scene",
          sceneTitle: "過去シーン",
          chunkText: "関連する過去の抜粋",
          charStart: 0,
          charEnd: 10,
          score: 0.9,
          dialogueRatio: 0,
        },
      ] as never);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "COPY SYS",
        totalTokens: 1,
        layers: [],
      });

      useChatStore.setState({
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "scene",
        scopeAnchorId: null,
        inputPinnedEntryIds: [],
        includeBodies: false, // eco
        messages: [],
      });

      const result = await useChatStore
        .getState()
        .buildPromptForCopy("今書いてる入力");

      // ① 入力を seed に意味検索が走り related_scenes が buildSystemPrompt へ
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-1",
          query: expect.stringContaining("今書いてる入力"),
        }),
      );
      expect(
        mockBuildSystemPrompt.mock.calls.at(-1)?.[0]?.semanticRecall,
      ).toBeDefined();
      // ④ eco: 本文ブランク
      expect(mockBuildSystemPrompt.mock.calls.at(-1)?.[0]?.scene.content).toBe(
        "",
      );
      // system + 末尾の入力行
      expect(result).toContain("[system]\nCOPY SYS");
      expect(result).toContain("[user]\n今書いてる入力");
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

      // folder/project スコープでも trimToFit が効くよう、モデル能力と会話
      // トークンが渡される (contextWindow と conversationTokens の両方が
      // 揃わないと buildSystemPrompt はトリムしない)。
      expect(args?.contextWindow).toBeGreaterThan(0);
      expect(args?.conversationTokens).toBeDefined();
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

  // プレビューは開いた瞬間に意味検索を1回走らせ related_scenes 込みで
  // プロンプトを組む（ライブの lastSystemPrompt には RAG が含まれないため）。
  describe("buildPreviewPrompt", () => {
    it("scene スコープ: 意味検索を seed 付きで走らせ related_scenes を含めて返す", async () => {
      const { getNode } = await import("@/features/tree/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { semanticSearch } = await import("@/features/semantic-search/api");
      const mockSearch = vi.mocked(semanticSearch);
      vi.mocked(useTreeStore.getState).mockReturnValue({
        nodes: [
          {
            id: "scene-1",
            parentId: null,
            nodeType: "scene",
            title: "テストシーン",
            sortOrder: "a0",
            synopsis: null,
            charCount: 100,
          },
        ],
        projectId: "proj-1",
      } as never);
      vi.mocked(getNode).mockResolvedValue({
        id: "scene-1",
        title: "テストシーン",
      } as never);
      mockSearch.mockResolvedValueOnce([
        {
          sceneId: "other-scene",
          sceneTitle: "過去シーン",
          chunkText: "関連する過去の抜粋",
          charStart: 0,
          charEnd: 10,
          score: 0.92,
          dialogueRatio: 0,
        },
      ] as never);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "PREVIEW PROMPT",
        totalTokens: 7,
        layers: [],
      });

      useChatStore.setState({
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "scene",
        scopeAnchorId: null,
        inputPinnedEntryIds: [],
        includeBodies: true,
        messages: [
          {
            id: "u1",
            sessionId: "",
            role: "user",
            content: "次の展開を相談したい",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      });

      const result = await useChatStore.getState().buildPreviewPrompt();

      // 直近ユーザー発話を seed に検索が走る
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-1",
          query: expect.stringContaining("次の展開を相談したい"),
        }),
      );
      // related_scenes が buildSystemPrompt に渡る
      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      expect(args?.semanticRecall).toBeDefined();
      expect(args?.semanticRecall?.[0]?.chunkText).toContain("関連する過去");
      expect(result.prompt).toBe("PREVIEW PROMPT");
    });

    it("非 scene スコープ: 検索せずライブ値を返す", async () => {
      const { semanticSearch } = await import("@/features/semantic-search/api");
      const mockSearch = vi.mocked(semanticSearch);
      mockSearch.mockClear();

      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        chatScope: "project",
        scopeAnchorId: null,
        lastSystemPrompt: "LIVE PROJECT PROMPT",
        contextLayers: [],
        contextTokenCount: 99,
      });

      const result = await useChatStore.getState().buildPreviewPrompt();

      expect(mockSearch).not.toHaveBeenCalled();
      expect(result).toEqual({
        prompt: "LIVE PROJECT PROMPT",
        layers: [],
        totalTokens: 99,
        userMessage: "",
      });
    });

    it("scene スコープ: 入力ドラフトを seed に使い userMessage を返す", async () => {
      const { getNode } = await import("@/features/tree/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { semanticSearch } = await import("@/features/semantic-search/api");
      const mockSearch = vi.mocked(semanticSearch);
      vi.mocked(useTreeStore.getState).mockReturnValue({
        nodes: [
          {
            id: "scene-1",
            parentId: null,
            nodeType: "scene",
            title: "テストシーン",
            sortOrder: "a0",
            synopsis: null,
            charCount: 100,
          },
        ],
        projectId: "proj-1",
      } as never);
      vi.mocked(getNode).mockResolvedValue({
        id: "scene-1",
        title: "テストシーン",
      } as never);
      mockSearch.mockResolvedValueOnce([] as never);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "P",
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
        includeBodies: true,
        messages: [
          {
            id: "u1",
            sessionId: "",
            role: "user",
            content: "履歴の発話",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      });

      useChatStore.getState().registerInputDraftProvider(() => ({
        markdown: "入力中のテキスト",
        mentionedSceneIds: [],
      }));

      const result = await useChatStore.getState().buildPreviewPrompt();

      // seed は履歴ではなく入力ドラフト(②)
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining("入力中のテキスト"),
        }),
      );
      // 入力メッセージをモーダルへ返す(③)
      expect(result.userMessage).toBe("入力中のテキスト");
    });

    it("不変条件: 同一入力で preview の prompt と copy の [system] が一致する", async () => {
      const { getNode } = await import("@/features/tree/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { semanticSearch } = await import("@/features/semantic-search/api");
      vi.mocked(useTreeStore.getState).mockReturnValue({
        nodes: [
          {
            id: "scene-1",
            parentId: null,
            nodeType: "scene",
            title: "テストシーン",
            sortOrder: "a0",
            synopsis: null,
            charCount: 100,
          },
        ],
        projectId: "proj-1",
      } as never);
      vi.mocked(getNode).mockResolvedValue({
        id: "scene-1",
        title: "テストシーン",
      } as never);
      vi.mocked(semanticSearch).mockResolvedValue([] as never);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "UNIFIED SYS",
        totalTokens: 3,
        layers: [],
      });

      useChatStore.setState({
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "scene",
        scopeAnchorId: null,
        inputPinnedEntryIds: [],
        includeBodies: true,
        messages: [],
      });
      useChatStore.getState().registerInputDraftProvider(() => ({
        markdown: "共通入力",
        mentionedSceneIds: [],
      }));

      mockBuildSystemPrompt.mockClear();
      const preview = await useChatStore.getState().buildPreviewPrompt();
      const copy = await useChatStore.getState().buildPromptForCopy("共通入力");

      // 両経路とも buildOutgoingScenePrompt 経由で buildSystemPrompt に到達する
      // (どちらかが早期 return すると 2 にならない)
      expect(mockBuildSystemPrompt).toHaveBeenCalledTimes(2);
      // 両経路とも同一 system prompt を返す
      expect(preview.prompt).toBe("UNIFIED SYS");
      expect(copy).toContain(`[system]\n${preview.prompt}`);
    });

    it("RAG 有効(agentトグルOFF+対応provider)では agentMode:true で組む(送信と一致)", async () => {
      const { getNode } = await import("@/features/tree/api");
      const { semanticSearch } = await import("@/features/semantic-search/api");
      const { useAiSettingsStore, DEFAULT_AI_SETTINGS } =
        await import("./store");
      vi.mocked(getNode).mockResolvedValue({
        id: "scene-1",
        title: "テストシーン",
      } as never);
      vi.mocked(semanticSearch).mockResolvedValue([] as never);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "P",
        totalTokens: 0,
        layers: [],
      });

      const prevSettings = useAiSettingsStore.getState().settings;
      useAiSettingsStore.setState({
        settings: { ...DEFAULT_AI_SETTINGS, provider: "openrouter" },
      });
      useChatStore.setState({
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "scene",
        scopeAnchorId: null,
        inputPinnedEntryIds: [],
        includeBodies: true,
        agentMode: false, // トグルは OFF
        ragEnabled: true, // だが RAG は ON
        messages: [],
      });
      useChatStore.getState().registerInputDraftProvider(() => ({
        markdown: "質問",
        mentionedSceneIds: [],
      }));

      await useChatStore.getState().buildPreviewPrompt();

      // send は RAG 有効時 agent パス(agentMode:true)に入るので preview も揃える
      expect(mockBuildSystemPrompt.mock.calls.at(-1)?.[0]?.agentMode).toBe(
        true,
      );

      // プロバイダ設定を元に戻す(他テストへの漏れ防止)
      useAiSettingsStore.setState({ settings: prevSettings });
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
      expect(mockListSessions).toHaveBeenCalledWith(
        "proj-1",
        undefined,
        "codex-1",
        undefined,
      );
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
        undefined,
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

  describe("setChatScope snippet", () => {
    it("sets snippet scope with anchor and includeBodies=false", () => {
      useChatStore.getState().setChatScope("snippet", "snip-1");
      const s = useChatStore.getState();
      expect(s.chatScope).toBe("snippet");
      expect(s.scopeAnchorId).toBe("snip-1");
      expect(s.includeBodies).toBe(false);
    });

    it("falls back to scene when snippet anchor is missing", () => {
      useChatStore.getState().setChatScope("snippet");
      const s = useChatStore.getState();
      expect(s.chatScope).toBe("scene");
      expect(s.includeBodies).toBe(true);
    });

    it("loadSessions passes snippetAnchorId to chatApi", async () => {
      mockListSessions.mockResolvedValueOnce([]);
      await useChatStore.getState().loadSessions(undefined, undefined, "sn-1");
      expect(mockListSessions).toHaveBeenCalledWith(
        "proj-1",
        undefined,
        undefined,
        "sn-1",
      );
    });

    it("ensureSession creates session with snippetAnchorId in snippet scope", async () => {
      mockCreateSession.mockResolvedValueOnce({
        ...session1,
        id: "new-snippet-session",
        nodeId: null,
        snippetAnchorId: "snip-1",
      });
      useChatStore.setState({
        activeSessionId: null,
        chatScope: "snippet",
        scopeAnchorId: "snip-1",
        activeProjectId: "proj-1",
      });
      const id = await useChatStore.getState().ensureSession();
      expect(mockCreateSession).toHaveBeenCalledWith(
        "proj-1",
        "New session",
        undefined,
        undefined,
        "snip-1",
      );
      expect(id).toBe("new-snippet-session");
    });

    it("setActiveSceneId keeps snippet scope session anchor", async () => {
      useChatStore.setState({
        chatScope: "snippet",
        scopeAnchorId: "snip-1",
        activeSessionId: "session-snippet",
        activeSceneId: "scene-old",
      });
      useChatStore.getState().setActiveSceneId("scene-new");
      const s = useChatStore.getState();
      expect(s.chatScope).toBe("snippet");
      expect(s.scopeAnchorId).toBe("snip-1");
      expect(s.activeSessionId).toBe("session-snippet");
    });
  });

  describe("onSnippetAnchorDeleted", () => {
    it("falls back to scene scope when deleted snippet matches anchor", () => {
      useChatStore.setState({
        chatScope: "snippet",
        scopeAnchorId: "snip-1",
        includeBodies: false,
      });
      useChatStore.getState().onSnippetAnchorDeleted("snip-1");
      const s = useChatStore.getState();
      expect(s.chatScope).toBe("scene");
      expect(s.scopeAnchorId).toBeNull();
      expect(s.includeBodies).toBe(true);
    });

    it("no-op when deleted snippet does not match anchor", () => {
      useChatStore.setState({
        chatScope: "snippet",
        scopeAnchorId: "snip-1",
        includeBodies: false,
      });
      useChatStore.getState().onSnippetAnchorDeleted("other-snippet");
      const s = useChatStore.getState();
      expect(s.chatScope).toBe("snippet");
      expect(s.scopeAnchorId).toBe("snip-1");
    });
  });

  describe("refreshContextLayers snippet scope", () => {
    // アンカーは L4 pinnedSnippets ではなく <focus_subject> (focusSubject) 経由で
    // フル本文注入する。scopeAnchor ストアフィールドにも反映され ContextBar に出る。
    it("injects the anchor snippet body via focusSubject, not pinnedSnippets", async () => {
      const { getSnippet } = await import("@/features/snippets/api");
      vi.mocked(getSnippet).mockResolvedValueOnce({
        id: "snip-1",
        projectId: "proj-1",
        title: "設定メモ",
        content: '{"type":"doc"}',
        tagsCache: null,
        contentSource: null,
        sceneId: null,
        sourceChatMessageId: null,
        usageCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });

      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        activeSessionId: "session-1",
        chatScope: "snippet",
        scopeAnchorId: "snip-1",
      });

      await useChatStore.getState().refreshContextLayers();

      expect(mockBuildSystemPrompt).toHaveBeenCalled();
      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      // focusSubject にアンカーが乗る
      const focus = args?.focusSubject;
      expect(focus).toBeDefined();
      expect(focus?.kind).toBe("snippet");
      if (focus?.kind === "snippet") {
        expect(focus.name).toBe("設定メモ");
      }
      // L4 pinnedSnippets には載らない (重複回避)
      const pinnedSnippets = args?.pinnedSnippets ?? [];
      expect(pinnedSnippets.find((s) => s.id === "snip-1")).toBeUndefined();
      // ContextBar 用の scopeAnchor も設定される
      const anchor = useChatStore.getState().scopeAnchor;
      expect(anchor).toEqual({
        kind: "snippet",
        id: "snip-1",
        title: "設定メモ",
      });
    });

    it("removes the anchor from pinnedSnippets even when it is also session-pinned (focus owns it)", async () => {
      const { getSnippet } = await import("@/features/snippets/api");
      vi.mocked(getSnippet).mockResolvedValueOnce({
        id: "snip-1",
        projectId: "proj-1",
        title: "設定メモ",
        content: '{"type":"doc"}',
        tagsCache: null,
        contentSource: null,
        sceneId: null,
        sourceChatMessageId: null,
        usageCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      vi.mocked(chatApi.listPinnedSnippetEntries).mockResolvedValueOnce([
        {
          id: "snip-1",
          title: "設定メモ",
          content: '{"type":"doc"}',
          pinnedType: "snippet",
          pinSource: "manual",
        } as never,
      ]);

      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        activeSessionId: "session-1",
        chatScope: "snippet",
        scopeAnchorId: "snip-1",
      });

      await useChatStore.getState().refreshContextLayers();

      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      const pinnedSnippets = args?.pinnedSnippets ?? [];
      // session pin と重複するアンカーは L4 から除外され、focus 側にだけ存在する
      expect(pinnedSnippets.filter((s) => s.id === "snip-1")).toHaveLength(0);
      expect(args?.focusSubject?.kind).toBe("snippet");
    });
  });

  describe("onCodexAnchorDeleted", () => {
    it("falls back to scene scope when deleted entry matches codex anchor", () => {
      useChatStore.setState({
        chatScope: "codex",
        scopeAnchorId: "codex-hero",
        includeBodies: false,
      });
      useChatStore.getState().onCodexAnchorDeleted("codex-hero");
      const s = useChatStore.getState();
      expect(s.chatScope).toBe("scene");
      expect(s.scopeAnchorId).toBeNull();
      expect(s.includeBodies).toBe(true);
    });

    it("no-op when deleted entry does not match codex anchor", () => {
      useChatStore.setState({
        chatScope: "codex",
        scopeAnchorId: "codex-hero",
        includeBodies: false,
      });
      useChatStore.getState().onCodexAnchorDeleted("other-entry");
      const s = useChatStore.getState();
      expect(s.chatScope).toBe("codex");
      expect(s.scopeAnchorId).toBe("codex-hero");
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

  // コンテキストバーの × で always エントリを外しても、always は毎ビルドで
  // allEntries から無条件再収集されるため、表示配列の除去だけでは次の
  // refresh でプロンプト・ピルとも復活していた（B3 回帰ガード）。
  describe("excludeEntryFromAuto (always エントリの auto 除外)", () => {
    const now = "2026-01-01T00:00:00Z";
    const alwaysEntry = {
      id: "always-1",
      projectId: "proj-1",
      parentId: null,
      type: "character",
      name: "常時キャラ",
      aliases: null,
      excludedAliases: null,
      summary: "always-summary",
      content: "{}",
      icon: null,
      tagsCache: null,
      contextMode: "always",
      childrenBudget: "compact",
      sourceChatMessageId: null,
      notes: null,
      createdAt: now,
      updatedAt: now,
    };

    beforeEach(() => {
      useChatStore.setState({
        excludedAutoEntryIds: [],
        detectedEntries: [],
        alwaysEntries: [],
        // 先行 describe (setIncludeMapBoard) の残留 state で scene 経路が
        // Map 読み込みに入り refresh ごと失敗するのを防ぐ
        includeMapBoard: false,
        mapBoardId: null,
      });
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "p",
        totalTokens: 0,
        layers: [],
      });
    });

    it("scene スコープ: 除外した always は refresh 後も注入・ピル復活しない", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      vi.mocked(listCodexEntries).mockResolvedValue([alwaysEntry] as never);

      useChatStore.setState({
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "scene",
        scopeAnchorId: null,
        inputPinnedEntryIds: [],
      });

      await useChatStore.getState().refreshContextLayers();
      let args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      expect((args?.codexEntries ?? []).map((e) => e.id)).toContain("always-1");
      expect(useChatStore.getState().alwaysEntries.map((e) => e.id)).toContain(
        "always-1",
      );

      useChatStore.getState().excludeEntryFromAuto("always-1");
      // excludeEntryFromAuto 内部の refresh は fire-and-forget なので、
      // 「次の refresh でも復活しない」ことを明示的な再実行で assert する
      await useChatStore.getState().refreshContextLayers();

      args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      expect((args?.codexEntries ?? []).map((e) => e.id)).not.toContain(
        "always-1",
      );
      expect(
        useChatStore.getState().alwaysEntries.map((e) => e.id),
      ).not.toContain("always-1");
    });

    it("project スコープ (グローバル経路): 除外 always はインライン再収集からも外れる", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      vi.mocked(listCodexEntries).mockResolvedValue([alwaysEntry] as never);
      vi.mocked(chatApi.listPinnedCodexEntries).mockResolvedValue([]);

      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        activeSessionId: "session-1",
        chatScope: "project",
        scopeAnchorId: null,
        inputPinnedEntryIds: [],
      });

      await useChatStore.getState().refreshContextLayers();
      let args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      expect((args?.codexEntries ?? []).map((e) => e.id)).toContain("always-1");

      useChatStore.getState().excludeEntryFromAuto("always-1");
      await useChatStore.getState().refreshContextLayers();

      args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      expect((args?.codexEntries ?? []).map((e) => e.id)).not.toContain(
        "always-1",
      );
      expect(
        useChatStore.getState().alwaysEntries.map((e) => e.id),
      ).not.toContain("always-1");
    });

    it("clearAutoExclusion は該当 ID のみ解除する", () => {
      useChatStore.setState({ excludedAutoEntryIds: ["a", "b"] });
      useChatStore.getState().clearAutoExclusion("a");
      expect(useChatStore.getState().excludedAutoEntryIds).toEqual(["b"]);
    });

    it("excludeEntryFromAuto は冪等で、表示配列からも即時除去する", () => {
      useChatStore.setState({
        alwaysEntries: [alwaysEntry as never],
        detectedEntries: [],
      });
      useChatStore.getState().excludeEntryFromAuto("always-1");
      useChatStore.getState().excludeEntryFromAuto("always-1");
      const s = useChatStore.getState();
      expect(s.excludedAutoEntryIds).toEqual(["always-1"]);
      expect(s.alwaysEntries).toEqual([]);
    });

    it("セッション切替で除外はクリアされる (セッション内スコープ)", async () => {
      useChatStore.setState({ excludedAutoEntryIds: ["always-1"] });
      await useChatStore.getState().selectSession(null);
      expect(useChatStore.getState().excludedAutoEntryIds).toEqual([]);
    });

    it("アクティブセッションの削除でも除外はクリアされる", async () => {
      useChatStore.setState({
        sessions: [
          {
            id: "sess-del",
            projectId: "proj-1",
            nodeId: "scene-1",
            title: "t",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          } as never,
        ],
        activeSessionId: "sess-del",
        excludedAutoEntryIds: ["always-1"],
      });
      await useChatStore.getState().deleteSession("sess-del");
      expect(useChatStore.getState().excludedAutoEntryIds).toEqual([]);
    });

    // × は detected/always を区別せず付く UI のため、除外は検出経路にも
    // 効かせる。always だけ弾くと detected の × が直後の refresh で即復活する。
    it("scene スコープ: 除外した detected エントリも再検出で復活しない", async () => {
      const { listCodexEntries } = await import("@/features/codex/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");
      const detEntry = {
        ...alwaysEntry,
        id: "det-1",
        name: "検出キャラ",
        contextMode: "mentioned",
      };
      vi.mocked(listCodexEntries).mockResolvedValue([detEntry] as never);
      vi.mocked(findMentionedEntriesAsync).mockImplementation(() =>
        Promise.resolve([
          {
            id: "det-1",
            name: "検出キャラ",
            type: "character",
            aliases: null,
            excludedAliases: null,
          },
        ] as never),
      );

      useChatStore.setState({
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "scene",
        scopeAnchorId: null,
        inputPinnedEntryIds: [],
      });

      try {
        await useChatStore.getState().refreshContextLayers();
        expect(
          useChatStore.getState().detectedEntries.map((e) => e.id),
        ).toContain("det-1");

        useChatStore.getState().excludeEntryFromAuto("det-1");
        await useChatStore.getState().refreshContextLayers();

        const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
        expect((args?.codexEntries ?? []).map((e) => e.id)).not.toContain(
          "det-1",
        );
        expect(
          useChatStore.getState().detectedEntries.map((e) => e.id),
        ).not.toContain("det-1");
      } finally {
        vi.mocked(findMentionedEntriesAsync).mockImplementation(() =>
          Promise.resolve([]),
        );
      }
    });
  });
});
