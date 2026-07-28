import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useChatStore, contextPromptKey } from "./chatStore";
import { useAiSettingsStore, DEFAULT_AI_SETTINGS } from "./store";
import { useProjectStore } from "@/features/project/projectStore";
import { useTabStore } from "@/features/editor/tabStore";
import { setCurrentImeWorkspaceIdentity } from "@/features/ime/workspaceScope";
import type { ChatMessage, ChatSession } from "./chatTypes";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("./chatApi", () => ({
  sendChatMessage: vi.fn(),
  sendChatMessageWithThinking: vi.fn(),
  sendChatMessageStream: vi.fn(),
  sendAgentMessage: vi.fn(),
  abortChatStream: vi.fn(() => Promise.resolve()),
  listSessions: vi.fn(),
  getSessionForProject: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  listMessages: vi.fn(),
  listSummaries: vi.fn(() => Promise.resolve([])),
  getSummaryGeneration: vi.fn(() => Promise.resolve(1)),
  addSummary: vi.fn(() =>
    Promise.resolve({
      id: "summary-1",
      sessionId: "session-1",
      summary: "summary",
      sourceMessageIds: [],
      tokenCount: 1,
      generation: 1,
      sourceMsgCount: 1,
      lastMsgId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  ),
  markMessagesSummarized: vi.fn(() => Promise.resolve()),
  addMessage: vi.fn(),
  saveMessagePrompt: vi.fn(() => Promise.resolve()),
  getMessagePrompt: vi.fn(() => Promise.resolve(null)),
  updateSessionTitle: vi.fn(),
  generateSessionTitle: vi.fn(() => Promise.resolve(null)),
  listPinnedCodexEntries: vi.fn(() => Promise.resolve([])),
  listPinnedSnippetEntries: vi.fn(() => Promise.resolve([])),
  listPinnedStickyEntries: vi.fn(() => Promise.resolve([])),
  pinCodexEntry: vi.fn(),
  unpinCodexEntry: vi.fn(),
}));

vi.mock("./codexAppApi", () => ({
  sendCodexAppTurn: vi.fn(),
  advanceCodexHistoryRevision: vi.fn(),
  abortCodexAppTurn: vi.fn(() => Promise.resolve()),
  setCodexSessionThreadName: vi.fn(() => Promise.resolve()),
  archiveCodexSessionThread: vi.fn(() => Promise.resolve()),
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
  getTokenEstimatorFamily: vi.fn(() => "o200k_base"),
}));

vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: vi.fn(() => Promise.resolve()),
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
  const loadSceneContent = vi.fn((_id: string) =>
    Promise.resolve("シーン本文"),
  );
  const loadSceneFull = vi.fn((_id: string) =>
    Promise.resolve({ content: "{}", unplacedBeatsDoc: "[]" }),
  );
  return {
    loadSceneContent,
    // Batch consumers preserve successfully loaded rows when a fixture marks
    // another id as unavailable, matching loadSceneContents' sparse Map.
    loadSceneContents: vi.fn(async (ids: string[]) => {
      const settled = await Promise.allSettled(
        ids.map((id) => loadSceneContent(id)),
      );
      const map = new Map<string, string>();
      for (let i = 0; i < ids.length; i++) {
        const result = settled[i];
        if (result.status === "fulfilled") map.set(ids[i], result.value);
      }
      return map;
    }),
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

vi.mock("@/features/codex/api", () => {
  const listCodexEntriesForContext = vi.fn(
    async (_projectId?: string): Promise<Array<Record<string, unknown>>> => [],
  );
  const withoutContent = (entry: Record<string, unknown>) => {
    const { content: _content, ...metadata } = entry;
    return metadata;
  };
  const pickMatchTarget = (entry: Record<string, unknown>) => ({
    id: entry.id,
    name: entry.name,
    type: entry.type,
    aliases: entry.aliases,
    excludedAliases: entry.excludedAliases,
  });
  return {
    listCodexEntries: vi.fn(() => Promise.resolve([])),
    listCodexEntriesForContext,
    listCodexContextMetadata: vi.fn(async (projectId: string) =>
      (await listCodexEntriesForContext(projectId)).map(withoutContent),
    ),
    listCodexEntriesForContextByIds: vi.fn(
      async (projectId: string, ids: readonly string[]) => {
        const byId = new Map(
          (await listCodexEntriesForContext(projectId)).map((entry) => [
            entry.id,
            entry,
          ]),
        );
        return [...new Set(ids)].flatMap((id) => {
          const entry = byId.get(id);
          return entry ? [entry] : [];
        });
      },
    ),
    listCodexMatchTargets: vi.fn(async (projectId: string) =>
      (await listCodexEntriesForContext(projectId)).map(pickMatchTarget),
    ),
  };
});

vi.mock("@/features/snippets/api", () => ({
  getSnippet: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("@/features/map/mapApi", () => ({
  getMapBoard: vi.fn(() => Promise.resolve(null)),
  listStickies: vi.fn(() => Promise.resolve([])),
  listUserEdges: vi.fn(() => Promise.resolve([])),
  listFrames: vi.fn(() => Promise.resolve([])),
  listNodePositions: vi.fn(() => Promise.resolve([])),
  listAiBranches: vi.fn(() => Promise.resolve([])),
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
  chatMessageSearch: vi.fn(() => Promise.resolve([])),
  chatIndexMessage: vi.fn(() => Promise.resolve(0)),
  chatIndexStatus: vi.fn(() => Promise.resolve(null)),
  chatReindexAll: vi.fn(() => Promise.resolve(0)),
}));

import * as chatApi from "./chatApi";
import * as codexAppApi from "./codexAppApi";
import type { ChatMessageResult, StreamCallbacks } from "./chatApi";
import * as contextBuilder from "./contextBuilder";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
const mockSendChatMessageStream = vi.mocked(chatApi.sendChatMessageStream);
const mockSendCodexAppTurn = vi.mocked(codexAppApi.sendCodexAppTurn);
const mockAdvanceCodexHistoryRevision = vi.mocked(
  codexAppApi.advanceCodexHistoryRevision,
);
const mockSendAgentMessage = vi.mocked(chatApi.sendAgentMessage);
const mockBuildSystemPrompt = vi.mocked(contextBuilder.buildSystemPrompt);
const mockRecordAiUsage = vi.mocked(recordAiUsage);

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
const mockGetSessionForProject = vi.mocked(chatApi.getSessionForProject);
const mockCreateSession = vi.mocked(chatApi.createSession);
const mockDeleteSession = vi.mocked(chatApi.deleteSession);
const mockListMessages = vi.mocked(chatApi.listMessages);
const mockAddMessage = vi.mocked(chatApi.addMessage);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resetStore() {
  useChatStore.setState({
    sessions: [],
    activeSessionId: null,
    isLoadingSessions: false,
    isLoadingMessages: false,
    messages: [],
    streamingDraft: null,
    isStreaming: false,
    error: null,
    activeSceneId: "scene-1",
    activeProjectId: "proj-1",
    contextTokenCount: 0,
    contextPlan: null,
    // スコープ/プロンプトキーはテスト間で漏れると stale 判定や copy 経路の
    // 分岐が前のテストの構成で動いてしまうため必ず初期化する
    chatScope: "scene",
    scopeAnchorId: null,
    includeBodies: true,
    includeMapBoard: false,
    mapBoardId: null,
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
  id: string = crypto.randomUUID(),
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
    setCurrentImeWorkspaceIdentity({
      path: "/workspace/chat-store-test",
      openRevision: 1,
    });
    // チャット用一時モデルはテスト間で漏れると後続の送信モデル判定を汚すので初期化。
    useAiSettingsStore.setState({
      chatModelOverride: null,
      chatProviderOverride: null,
      chatModelVariantOverride: null,
    });
    // policy 既定はクリア（projects 空 → fail-open=full）。chat ガードを
    // 素通りさせ、既存の sendMessage テストを従来どおり走らせる。
    useProjectStore.setState({ currentProjectId: null, projects: [] });
    useTabStore.setState({ tabs: [], activeTabId: null });
    // プロンプトプレビューの入力ドラフト DI をテスト間でリセット
    useChatStore.getState().registerInputDraftProvider(null);
    mockCreateSession.mockImplementation(
      async (projectId, title, nodeId, codexAnchorId, snippetAnchorId) => ({
        ...session1,
        projectId,
        title,
        nodeId: nodeId ?? null,
        codexAnchorId: codexAnchorId ?? null,
        snippetAnchorId: snippetAnchorId ?? null,
      }),
    );
    mockGetSessionForProject.mockImplementation(async (sessionId, projectId) =>
      sessionId
        ? {
            ...session1,
            id: sessionId,
            projectId,
          }
        : null,
    );
  });

  // --- Session management tests ---

  describe("loadSessions", () => {
    it("loads sessions for a scene", async () => {
      mockListSessions.mockResolvedValueOnce([session1, session2]);

      const loaded = await useChatStore.getState().loadSessions("scene-1");

      const state = useChatStore.getState();
      expect(loaded).toBe(true);
      expect(state.sessions).toHaveLength(2);
      expect(mockListSessions).toHaveBeenCalledWith(
        "proj-1",
        "scene-1",
        undefined,
        undefined,
      );
    });

    it("rejects a list key that does not match the active scope without touching state", async () => {
      useChatStore.setState({
        sessions: [session1],
        isLoadingSessions: false,
      });

      await expect(
        useChatStore
          .getState()
          .loadSessions(undefined, undefined, "stale-snippet"),
      ).resolves.toBe(false);

      expect(mockListSessions).not.toHaveBeenCalled();
      expect(useChatStore.getState().sessions).toEqual([session1]);
      expect(useChatStore.getState().isLoadingSessions).toBe(false);
    });

    it("loads the null-node session list for the active project scope", async () => {
      const projectSession = {
        ...session1,
        id: "project-session",
        nodeId: null,
      };
      useChatStore.setState({
        chatScope: "project",
        scopeAnchorId: null,
      });
      mockListSessions.mockResolvedValueOnce([projectSession]);

      await expect(useChatStore.getState().loadSessions(null)).resolves.toBe(
        true,
      );

      expect(mockListSessions).toHaveBeenCalledWith(
        "proj-1",
        null,
        undefined,
        undefined,
      );
      expect(useChatStore.getState().sessions).toEqual([projectSession]);
    });

    it("sets isLoadingSessions during load", async () => {
      let resolvePromise: (value: ChatSession[]) => void;
      const promise = new Promise<ChatSession[]>((resolve) => {
        resolvePromise = resolve;
      });
      mockListSessions.mockReturnValueOnce(promise);
      useChatStore.setState({
        summaryCount: 2,
        maxSummaryGeneration: 1,
        sessionStableCodexIds: ["codex-scene-1"],
        sessionStableContextInitialized: true,
        sessionAgentToolsSnapshot: [],
      });

      const loadPromise = useChatStore.getState().loadSessions("scene-1");
      expect(useChatStore.getState().isLoadingSessions).toBe(true);

      resolvePromise!([session1]);
      await loadPromise;

      expect(useChatStore.getState().isLoadingSessions).toBe(false);
    });

    it("discards an in-flight scene history load after the active scene changes", async () => {
      let resolvePromise: (value: ChatSession[]) => void;
      const promise = new Promise<ChatSession[]>((resolve) => {
        resolvePromise = resolve;
      });
      mockListSessions.mockReturnValueOnce(promise);

      const loadPromise = useChatStore.getState().loadSessions("scene-1");
      useChatStore.getState().setActiveSceneId("scene-2");
      resolvePromise!([session1]);
      await expect(loadPromise).resolves.toBe(false);

      const state = useChatStore.getState();
      expect(state.activeSceneId).toBe("scene-2");
      expect(state.sessions).toEqual([]);
      expect(state.activeSessionId).toBeNull();
      expect(state.messages).toEqual([]);
      expect(state.isLoadingSessions).toBe(false);
      expect(state.isLoadingMessages).toBe(false);
      expect(state.summaryCount).toBe(0);
      expect(state.maxSummaryGeneration).toBe(0);
      expect(state.sessionStableCodexIds).toEqual([]);
      expect(state.sessionStableContextInitialized).toBe(false);
      expect(state.sessionAgentToolsSnapshot).toBeNull();
    });

    it("does not publish scope A list completion over scope B state", async () => {
      const scopeA = {
        ...session1,
        id: "session-scope-a",
        nodeId: null,
        snippetAnchorId: "snip-a",
      };
      const scopeB = {
        ...session2,
        id: "session-scope-b",
        nodeId: null,
        snippetAnchorId: "snip-b",
      };
      const pending = deferred<ChatSession[]>();
      useChatStore.setState({
        chatScope: "snippet",
        scopeAnchorId: "snip-a",
        sessions: [scopeA],
      });
      mockListSessions.mockReturnValueOnce(pending.promise);

      const loading = useChatStore
        .getState()
        .loadSessions(undefined, undefined, "snip-a");
      expect(useChatStore.getState().isLoadingSessions).toBe(true);

      useChatStore.setState({
        chatScope: "snippet",
        scopeAnchorId: "snip-b",
        sessions: [scopeB],
        isLoadingSessions: false,
      });
      pending.resolve([scopeA]);

      await expect(loading).resolves.toBe(false);
      expect(useChatStore.getState().sessions).toEqual([scopeB]);
      expect(useChatStore.getState().isLoadingSessions).toBe(false);
    });

    it("reports a failed history load without treating stale sessions as fresh", async () => {
      useChatStore.setState({ sessions: [session1] });
      mockListSessions.mockRejectedValueOnce(new Error("load failed"));

      await expect(
        useChatStore.getState().loadSessions("scene-1"),
      ).resolves.toBe(false);

      expect(useChatStore.getState().sessions).toEqual([]);
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

    it("does not run a queued selection after the scope changes", async () => {
      useChatStore.setState({
        sessions: [session1, session2],
        activeSessionId: session1.id,
      });
      let resolveCreate!: (session: ChatSession) => void;
      mockCreateSession.mockReturnValueOnce(
        new Promise<ChatSession>((resolve) => {
          resolveCreate = resolve;
        }),
      );

      const create = useChatStore
        .getState()
        .createNewSession("proj-1", "first", "scene-1");
      await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
      const selection = useChatStore.getState().selectSession(session2.id);

      useChatStore.setState({ activeSceneId: "scene-2" });
      resolveCreate(session2);
      await Promise.all([create, selection]);

      expect(mockGetSessionForProject).not.toHaveBeenCalled();
      expect(useChatStore.getState().activeSessionId).toBe(session1.id);
    });

    it("does not publish a deferred scope A selection after moving to scope B", async () => {
      const scopeA = {
        ...session1,
        id: "session-scope-a",
        nodeId: null,
        snippetAnchorId: "snip-a",
      };
      const scopeB = {
        ...session2,
        id: "session-scope-b",
        nodeId: null,
        snippetAnchorId: "snip-b",
      };
      const pending = deferred<ChatSession | null>();
      useChatStore.setState({
        chatScope: "snippet",
        scopeAnchorId: "snip-a",
        sessions: [scopeA],
        activeSessionId: null,
      });
      mockGetSessionForProject.mockReturnValueOnce(pending.promise);

      const selection = useChatStore.getState().selectSession(scopeA.id);
      await vi.waitFor(() =>
        expect(mockGetSessionForProject).toHaveBeenCalledOnce(),
      );

      useChatStore.setState({
        chatScope: "snippet",
        scopeAnchorId: "snip-b",
        sessions: [scopeB],
        activeSessionId: null,
        messages: [msg2],
        isLoadingMessages: false,
      });
      pending.resolve(scopeA);
      await selection;

      expect(mockListMessages).not.toHaveBeenCalled();
      expect(useChatStore.getState()).toMatchObject({
        sessions: [scopeB],
        activeSessionId: null,
        messages: [msg2],
        isLoadingMessages: false,
      });
    });

    it("synchronously clears scope A session state when a deferred selection crosses into scope B", async () => {
      const scopeA = {
        ...session1,
        id: "same-session-id",
        nodeId: null,
        snippetAnchorId: "snip-a",
      };
      const pending = deferred<ChatSession | null>();
      useChatStore.setState({
        chatScope: "snippet",
        scopeAnchorId: "snip-a",
        sessions: [scopeA],
        activeSessionId: null,
        messages: [msg2],
        summaryCount: 3,
        maxSummaryGeneration: 2,
        sessionStableCodexIds: ["codex-a"],
        sessionStableContextInitialized: true,
        sessionAgentToolsSnapshot: [],
        excludedAutoEntryIds: ["codex-excluded"],
        isLoadingSessions: true,
      });
      mockGetSessionForProject.mockReturnValueOnce(pending.promise);

      const selection = useChatStore.getState().selectSession(scopeA.id);
      await vi.waitFor(() =>
        expect(mockGetSessionForProject).toHaveBeenCalledOnce(),
      );
      expect(useChatStore.getState()).toMatchObject({
        activeSessionId: scopeA.id,
        isLoadingMessages: true,
      });

      useChatStore.getState().setChatScope("snippet", "snip-b");

      expect(useChatStore.getState()).toMatchObject({
        chatScope: "snippet",
        scopeAnchorId: "snip-b",
        sessions: [],
        activeSessionId: null,
        messages: [],
        isLoadingSessions: false,
        isLoadingMessages: false,
        summaryCount: 0,
        maxSummaryGeneration: 0,
        sessionStableCodexIds: [],
        sessionStableContextInitialized: false,
        sessionAgentToolsSnapshot: null,
        excludedAutoEntryIds: [],
      });

      pending.resolve(scopeA);
      await selection;

      expect(mockListMessages).not.toHaveBeenCalled();
      expect(useChatStore.getState()).toMatchObject({
        chatScope: "snippet",
        scopeAnchorId: "snip-b",
        sessions: [],
        activeSessionId: null,
        messages: [],
        isLoadingSessions: false,
        isLoadingMessages: false,
      });
    });

    it("does not select a listed session outside the current scope key", async () => {
      const scopeA = {
        ...session1,
        id: "session-scope-a",
        nodeId: null,
        snippetAnchorId: "snip-a",
      };
      useChatStore.setState({
        chatScope: "snippet",
        scopeAnchorId: "snip-b",
        sessions: [scopeA],
        activeSessionId: null,
      });

      await useChatStore.getState().selectSession(scopeA.id);

      expect(mockGetSessionForProject).not.toHaveBeenCalled();
      expect(useChatStore.getState().activeSessionId).toBeNull();
    });

    it("rejects a fetched same-project session outside the current scope key", async () => {
      const scopeA = {
        ...session1,
        id: "unlisted-scope-a",
        nodeId: null,
        snippetAnchorId: "snip-a",
      };
      useChatStore.setState({
        chatScope: "snippet",
        scopeAnchorId: "snip-b",
        sessions: [],
        activeSessionId: null,
      });
      mockGetSessionForProject.mockResolvedValueOnce(scopeA);

      await useChatStore.getState().selectSession(scopeA.id);

      expect(mockListMessages).not.toHaveBeenCalled();
      expect(useChatStore.getState().activeSessionId).toBeNull();
      expect(useChatStore.getState().messages).toEqual([]);
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

    it("does not inherit the desktop OpenRouter model for a fresh Web session", async () => {
      const previousSettings = useAiSettingsStore.getState().settings;
      vi.stubGlobal("document", {
        documentElement: { dataset: { runtimeTarget: "web" } },
      });
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "ollama",
          model: "",
        },
      });
      mockCreateSession.mockResolvedValueOnce({ ...session1, model: "" });

      try {
        await useChatStore
          .getState()
          .createNewSession("proj-1", "Web conversation", "scene-1");

        expect(mockCreateSession).toHaveBeenCalledWith(
          "proj-1",
          "Web conversation",
          "scene-1",
          undefined,
          undefined,
          "",
        );
      } finally {
        useAiSettingsStore.setState({ settings: previousSettings });
        vi.unstubAllGlobals();
      }
    });

    it("does not replace the active session while a turn is streaming", async () => {
      useChatStore.setState({ isStreaming: true });

      await useChatStore
        .getState()
        .createNewSession("proj-1", "blocked", "scene-1");

      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it("finishes a previously requested session creation before Send captures authority", async () => {
      let resolveCreate!: (session: ChatSession) => void;
      mockCreateSession.mockReturnValueOnce(
        new Promise<ChatSession>((resolve) => {
          resolveCreate = resolve;
        }),
      );
      mockStreamResponse("new-session answer");

      const create = useChatStore
        .getState()
        .createNewSession("proj-1", "new", "scene-1");
      await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
      const send = useChatStore.getState().sendMessage("new-session question");
      await Promise.resolve();

      expect(mockSendChatMessageStream).not.toHaveBeenCalled();
      resolveCreate(session2);
      await create;
      await send;

      expect(mockCreateSession).toHaveBeenCalledOnce();
      expect(useChatStore.getState().activeSessionId).toBe(session2.id);
      expect(
        useChatStore.getState().messages.map((message) => message.sessionId),
      ).toEqual([session2.id, session2.id]);
    });

    it("does not let a later session creation overtake a Send start", async () => {
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
      });
      let streamCallbacks: StreamCallbacks | undefined;
      mockSendChatMessageStream.mockImplementation(
        async (_messages, _params, callbacks: StreamCallbacks) => {
          streamCallbacks = callbacks;
          return () => {};
        },
      );

      const send = useChatStore
        .getState()
        .sendMessage("existing-session question");
      const create = useChatStore
        .getState()
        .createNewSession("proj-1", "too late", "scene-1");
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      await create;

      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(useChatStore.getState().activeSessionId).toBe(session1.id);
      streamCallbacks?.onTextDelta("existing-session answer");
      streamCallbacks?.onDone({ stopReason: "completed" });
      await send;
    });

    it("does not publish a created session after the workspace identity changes", async () => {
      let resolveCreate!: (session: ChatSession) => void;
      mockCreateSession.mockReturnValueOnce(
        new Promise<ChatSession>((resolve) => {
          resolveCreate = resolve;
        }),
      );

      const create = useChatStore
        .getState()
        .createNewSession("proj-1", "stale", "scene-1");
      await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

      setCurrentImeWorkspaceIdentity({
        path: "/workspace/chat-store-test",
        openRevision: 2,
      });
      resolveCreate(session1);
      await create;

      expect(useChatStore.getState().activeSessionId).toBeNull();
      expect(useChatStore.getState().sessions).toEqual([]);
    });

    it("does not publish a stale create error after a same-path workspace reopen", async () => {
      const pending = deferred<ChatSession>();
      mockCreateSession.mockReturnValueOnce(pending.promise);

      const creation = useChatStore
        .getState()
        .createNewSession("proj-1", "stale", "scene-1");
      await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());

      setCurrentImeWorkspaceIdentity({
        path: "/workspace/chat-store-test",
        openRevision: 2,
      });
      pending.reject(new Error("workspace A create failed"));
      await creation;

      expect(toast.error).not.toHaveBeenCalled();
      expect(useChatStore.getState().activeSessionId).toBeNull();
      expect(useChatStore.getState().sessions).toEqual([]);
    });
  });

  describe("createLinkedSession", () => {
    it("does not replace the active session while a turn is streaming", async () => {
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        isStreaming: true,
      });

      await useChatStore.getState().createLinkedSession();

      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(useChatStore.getState().activeSessionId).toBe(session1.id);
    });

    it("does not retarget a queued link operation after the scope changes", async () => {
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
      });
      let resolveFirstCreate!: (session: ChatSession) => void;
      mockCreateSession.mockReturnValueOnce(
        new Promise<ChatSession>((resolve) => {
          resolveFirstCreate = resolve;
        }),
      );

      const firstCreate = useChatStore
        .getState()
        .createNewSession("proj-1", "first", "scene-1");
      await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
      const linkedCreate = useChatStore.getState().createLinkedSession();

      useChatStore.setState({ activeSceneId: "scene-2" });
      resolveFirstCreate(session2);
      await Promise.all([firstCreate, linkedCreate]);

      expect(mockCreateSession).toHaveBeenCalledOnce();
      expect(useChatStore.getState().activeSessionId).toBe(session1.id);
    });
  });

  describe("ensureSession authority", () => {
    it("does not reuse a session from a different resolved scope", async () => {
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        activeSceneId: "scene-2",
      });

      expect(await useChatStore.getState().ensureSession()).toBeNull();
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it("does not retarget a queued ensure after a workspace reopen", async () => {
      let resolveCreate!: (session: ChatSession) => void;
      mockCreateSession.mockReturnValueOnce(
        new Promise<ChatSession>((resolve) => {
          resolveCreate = resolve;
        }),
      );

      const create = useChatStore
        .getState()
        .createNewSession("proj-1", "first", "scene-1");
      await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
      const ensured = useChatStore.getState().ensureSession();

      setCurrentImeWorkspaceIdentity({
        path: "/workspace/chat-store-test",
        openRevision: 2,
      });
      resolveCreate(session1);
      await create;

      expect(await ensured).toBeNull();
      expect(mockCreateSession).toHaveBeenCalledOnce();
      expect(useChatStore.getState().activeSessionId).toBeNull();
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
      expect(codexAppApi.archiveCodexSessionThread).toHaveBeenCalledWith({
        projectId: "proj-1",
        sessionId: "session-1",
        expectedWorkspacePath: "/workspace/chat-store-test",
      });
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

    it("does not delete a session while a turn is streaming", async () => {
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        isStreaming: true,
      });

      await useChatStore.getState().deleteSession(session1.id);

      expect(mockDeleteSession).not.toHaveBeenCalled();
      expect(codexAppApi.archiveCodexSessionThread).not.toHaveBeenCalled();
      expect(useChatStore.getState().activeSessionId).toBe(session1.id);
    });

    it("does not delete when the session is not owned by the captured project", async () => {
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
      });
      mockGetSessionForProject.mockResolvedValueOnce(null);

      await useChatStore.getState().deleteSession(session1.id);

      expect(mockDeleteSession).not.toHaveBeenCalled();
      expect(codexAppApi.archiveCodexSessionThread).not.toHaveBeenCalled();
    });

    it("does not continue deletion after a same-path workspace reopen", async () => {
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
      });
      let resolveOwnership!: (session: ChatSession | null) => void;
      mockGetSessionForProject.mockReturnValueOnce(
        new Promise<ChatSession | null>((resolve) => {
          resolveOwnership = resolve;
        }),
      );

      const deletion = useChatStore.getState().deleteSession(session1.id);
      await vi.waitFor(() =>
        expect(mockGetSessionForProject).toHaveBeenCalledWith(
          session1.id,
          "proj-1",
        ),
      );
      setCurrentImeWorkspaceIdentity({
        path: "/workspace/chat-store-test",
        openRevision: 2,
      });
      resolveOwnership(session1);
      await deletion;

      expect(mockDeleteSession).not.toHaveBeenCalled();
      expect(codexAppApi.archiveCodexSessionThread).not.toHaveBeenCalled();
    });

    it("does not publish a stale delete error after a same-path workspace reopen", async () => {
      const pending = deferred<void>();
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
      });
      mockDeleteSession.mockReturnValueOnce(pending.promise);

      const deletion = useChatStore.getState().deleteSession(session1.id);
      await vi.waitFor(() =>
        expect(mockDeleteSession).toHaveBeenCalledWith(session1.id),
      );
      setCurrentImeWorkspaceIdentity({
        path: "/workspace/chat-store-test",
        openRevision: 2,
      });
      pending.reject(new Error("workspace A delete failed"));
      await deletion;

      expect(toast.error).not.toHaveBeenCalled();
      expect(useChatStore.getState().sessions).toEqual([session1]);
      expect(useChatStore.getState().activeSessionId).toBe(session1.id);
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

  describe("appendAdoptedAbTurn", () => {
    const mockSaveMessagePrompt = vi.mocked(chatApi.saveMessagePrompt);

    it("ensures a session, appends user + assistant turn, and snapshots the prompt", async () => {
      // activeSessionId が null → ensureSession が createSession を呼ぶ。
      useChatStore.setState({
        sessions: [],
        activeSessionId: null,
        messages: [],
        chatScope: "scene",
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
      });
      const userMsg = makeMessage("user", "下書き");
      const assistantMsg = makeMessage("assistant", "採用応答");
      mockCreateSession.mockResolvedValueOnce(session1);
      mockAddMessage
        .mockResolvedValueOnce(userMsg)
        .mockResolvedValueOnce(assistantMsg);

      const ok = await useChatStore.getState().appendAdoptedAbTurn({
        userDraft: "下書き",
        basePrompt: "FULL PROMPT",
        mentionedSceneIds: ["scene-9"],
        assistantText: "採用応答",
        model: "openai/gpt-4o",
      });

      expect(ok).toBe(true);
      expect(mockCreateSession).toHaveBeenCalledTimes(1);

      // user + assistant の 2 メッセージを順に積む。
      expect(mockAddMessage).toHaveBeenCalledTimes(2);
      const [userCall, assistantCall] = mockAddMessage.mock.calls;
      expect(userCall[0]).toBe("session-1");
      expect(userCall[1]).toBe("user");
      expect(userCall[2]).toBe("下書き");
      expect(userCall[3]?.metadata).toBe(
        JSON.stringify({ mentioned_scene_ids: ["scene-9"] }),
      );
      expect(assistantCall[1]).toBe("assistant");
      expect(assistantCall[2]).toBe("採用応答");
      expect(assistantCall[3]?.model).toBe("openai/gpt-4o");
      expect(assistantCall[3]?.metadata).toBe(
        JSON.stringify({ ab_adopted: true }),
      );

      // 制作過程開示: basePrompt を user メッセージのスナップショットへ。
      expect(mockSaveMessagePrompt).toHaveBeenCalledWith(userMsg.id, {
        systemPrompt: "FULL PROMPT",
        layers: [],
        totalTokens: null,
        model: "openai/gpt-4o",
      });

      // in-memory messages に両方反映。
      const msgs = useChatStore.getState().messages;
      expect(msgs.map((m) => m.id)).toEqual([userMsg.id, assistantMsg.id]);
    });

    it("reuses the existing active session and skips snapshot when basePrompt is empty", async () => {
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: "session-1",
        messages: [],
      });
      mockAddMessage
        .mockResolvedValueOnce(makeMessage("user", "d"))
        .mockResolvedValueOnce(makeMessage("assistant", "r"));

      const ok = await useChatStore.getState().appendAdoptedAbTurn({
        userDraft: "d",
        basePrompt: "",
        mentionedSceneIds: [],
        assistantText: "r",
        model: null,
      });

      expect(ok).toBe(true);
      expect(mockCreateSession).not.toHaveBeenCalled();
      // basePrompt 空 → スナップショットは呼ばない。
      expect(mockSaveMessagePrompt).not.toHaveBeenCalled();
      // mentions 空 → user metadata なし / model null → assistant に model 指定なし。
      const [userCall, assistantCall] = mockAddMessage.mock.calls;
      expect(userCall[3]?.metadata).toBeUndefined();
      expect(assistantCall[3]?.model).toBeUndefined();
      expect(assistantCall[3]?.metadata).toBe(
        JSON.stringify({ ab_adopted: true }),
      );
    });

    it("returns false and records nothing when the session cannot be created", async () => {
      useChatStore.setState({
        sessions: [],
        activeSessionId: null,
        messages: [],
      });
      mockCreateSession.mockRejectedValueOnce(new Error("db down"));

      const ok = await useChatStore.getState().appendAdoptedAbTurn({
        userDraft: "d",
        basePrompt: "p",
        mentionedSceneIds: [],
        assistantText: "r",
        model: null,
      });

      expect(ok).toBe(false);
      expect(mockAddMessage).not.toHaveBeenCalled();
      expect(useChatStore.getState().messages).toHaveLength(0);
    });
  });

  // --- sendMessage tests ---

  describe("sendMessage", () => {
    it("fails closed and rolls back placeholders when auto-creating a session fails", async () => {
      mockCreateSession.mockRejectedValueOnce(
        new Error("session db unavailable"),
      );

      await useChatStore.getState().sendMessage("初回質問");

      expect(mockSendChatMessageStream).not.toHaveBeenCalled();
      expect(useChatStore.getState().messages).toEqual([]);
      expect(useChatStore.getState().isStreaming).toBe(false);
      expect(useChatStore.getState().error).toContain("session db unavailable");
    });

    it("does not adopt an auto-created old-scene session after navigation", async () => {
      let resolveCreate!: (session: ChatSession) => void;
      mockCreateSession.mockReturnValueOnce(
        new Promise<ChatSession>((resolve) => {
          resolveCreate = resolve;
        }),
      );

      const send = useChatStore.getState().sendMessage("シーンAの質問");
      await vi.waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
      useChatStore.setState({ activeSceneId: "scene-2" });
      resolveCreate(session1);
      await send;

      expect(mockSendChatMessageStream).not.toHaveBeenCalled();
      expect(useChatStore.getState().activeSessionId).toBeNull();
      expect(useChatStore.getState().sessions).toEqual([]);
      expect(useChatStore.getState().messages).toEqual([]);
      expect(useChatStore.getState().isStreaming).toBe(false);
    });

    it("validates persisted session ownership before reading turn sources", async () => {
      mockGetSessionForProject.mockResolvedValueOnce(null);
      useChatStore.setState({
        sessions: [],
        activeSessionId: "foreign-session",
        messages: [],
      });

      await useChatStore.getState().sendMessage("質問");

      expect(mockSendChatMessageStream).not.toHaveBeenCalled();
      expect(chatApi.listSummaries).not.toHaveBeenCalled();
      expect(useChatStore.getState().messages).toEqual([]);
      expect(useChatStore.getState().error).toBe(
        "chat session project mismatch",
      );
    });

    it("continues the turn after adopting its auto-created session", async () => {
      mockCreateSession.mockResolvedValueOnce(session1);
      mockStreamResponse("初回回答");

      await useChatStore.getState().sendMessage("初回質問");

      expect(mockSendChatMessageStream).toHaveBeenCalledOnce();
      expect(useChatStore.getState().activeSessionId).toBe(session1.id);
      expect(
        useChatStore.getState().messages.map((message) => message.sessionId),
      ).toEqual([session1.id, session1.id]);
    });

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

    it("advances a completed Codex App Server turn only after both messages persist", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "cli",
          model: "gpt-5",
          cli: {
            kind: "codex",
            binaryPath: "/usr/bin/codex",
            model: "gpt-5",
            codexTransport: "app-server",
          },
        },
      });
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        agentMode: false,
        ragEnabled: false,
      });
      mockSendCodexAppTurn.mockImplementation(async (_payload, callbacks) => {
        callbacks.onTurnStarted?.({
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
        });
        callbacks.onTextDelta("App Server 応答");
        callbacks.onDone({ stopReason: "completed" });
        return () => {};
      });
      mockAdvanceCodexHistoryRevision.mockResolvedValue({
        status: "advanced",
      });

      await useChatStore.getState().sendMessage("App Server 質問");

      expect(mockAddMessage).toHaveBeenCalledTimes(2);
      const startPayload = mockSendCodexAppTurn.mock.calls[0]?.[0];
      expect(startPayload).toBeDefined();
      expect(mockAdvanceCodexHistoryRevision).toHaveBeenCalledWith({
        projectId: "proj-1",
        sessionId: "session-1",
        grimodexTurnId: startPayload?.grimodexTurnId,
        codexThreadId: "codex-thread-1",
        codexTurnId: "codex-turn-1",
        expectedHistoryRevision: startPayload?.historyRevision,
        nextHistoryRevision: expect.any(String),
      });
      expect(mockAddMessage.mock.invocationCallOrder.at(-1)).toBeLessThan(
        mockAdvanceCodexHistoryRevision.mock.invocationCallOrder[0] ?? 0,
      );
      expect(
        mockAdvanceCodexHistoryRevision.mock.calls[0]?.[0].nextHistoryRevision,
      ).not.toBe(startPayload?.historyRevision);
      useAiSettingsStore.setState({ settings: null });
    });

    it("keeps the current user message out of App Server bootstrap after summarization", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "cli",
          model: "gpt-5",
          cli: {
            kind: "codex",
            binaryPath: "/usr/bin/codex",
            model: "gpt-5",
            codexTransport: "app-server",
          },
        },
      });
      const history = Array.from({ length: 5 }, (_, index) => [
        makeMessage("user", `past-user-${index}`, `past-user-${index}`),
        makeMessage(
          "assistant",
          `past-assistant-${index}`,
          `past-assistant-${index}`,
        ),
      ]).flat();
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        messages: history,
        agentMode: false,
        ragEnabled: false,
      });
      vi.mocked(contextBuilder.allocateLayerBudgets).mockReturnValueOnce({
        responseReservation: 1,
        l1: 1,
        l2: 1,
        l3: 1,
        l4: 1,
        l5: 1,
        degraded: false,
      });
      vi.mocked(chatApi.sendChatMessageWithThinking).mockResolvedValueOnce({
        text: "summary result",
        thinkingBlocks: [],
        inputTokens: 1,
        outputTokens: 1,
      });
      mockSendCodexAppTurn.mockImplementation(async (_payload, callbacks) => {
        callbacks.onTurnStarted?.({
          threadId: "codex-thread-summary",
          turnId: "codex-turn-summary",
        });
        callbacks.onTextDelta("summary-safe answer");
        callbacks.onDone({ stopReason: "completed" });
        return () => {};
      });

      await useChatStore.getState().sendMessage("CURRENT-USER-QUESTION");

      expect(chatApi.addSummary).toHaveBeenCalledOnce();
      const payload = mockSendCodexAppTurn.mock.calls[0]?.[0];
      expect(payload?.userMessage).toBe("CURRENT-USER-QUESTION");
      expect(payload?.bootstrapHistory).not.toContain("CURRENT-USER-QUESTION");
      expect(mockAdvanceCodexHistoryRevision).toHaveBeenCalledOnce();
      useAiSettingsStore.setState({ settings: null });
    });

    it("does not advance Codex history when assistant persistence fails", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "cli",
          model: "gpt-5",
          cli: {
            kind: "codex",
            binaryPath: "/usr/bin/codex",
            model: "gpt-5",
            codexTransport: "app-server",
          },
        },
      });
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        agentMode: false,
        ragEnabled: false,
      });
      mockSendCodexAppTurn.mockImplementation(async (_payload, callbacks) => {
        callbacks.onTurnStarted?.({
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
        });
        callbacks.onTextDelta("App Server 応答");
        callbacks.onDone({ stopReason: "completed" });
        return () => {};
      });
      mockAddMessage
        .mockResolvedValueOnce(msg1)
        .mockRejectedValueOnce(new Error("assistant insert failed"));

      await useChatStore.getState().sendMessage("App Server 質問");

      expect(mockAddMessage).toHaveBeenCalledTimes(2);
      expect(mockAdvanceCodexHistoryRevision).not.toHaveBeenCalled();
      useAiSettingsStore.setState({ settings: null });
    });

    it("does not advance Codex history when prior messages change during the turn", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "cli",
          model: "gpt-5",
          cli: {
            kind: "codex",
            binaryPath: "/usr/bin/codex",
            model: "gpt-5",
            codexTransport: "app-server",
          },
        },
      });
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        messages: [msg1],
        agentMode: false,
        ragEnabled: false,
      });
      let streamCallbacks: codexAppApi.CodexAppStreamCallbacks | undefined;
      mockSendCodexAppTurn.mockImplementation(async (_payload, callbacks) => {
        streamCallbacks = callbacks;
        callbacks.onTurnStarted?.({
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
        });
        callbacks.onTextDelta("App Server 応答");
        return () => {};
      });

      const send = useChatStore.getState().sendMessage("App Server 質問");
      await vi.waitFor(() => expect(streamCallbacks).toBeDefined());
      useChatStore.setState((state) => ({
        messages: state.messages.filter((message) => message.id !== msg1.id),
      }));
      streamCallbacks?.onDone({ stopReason: "completed" });
      await send;

      expect(mockAddMessage).toHaveBeenCalledTimes(2);
      expect(mockAdvanceCodexHistoryRevision).not.toHaveBeenCalled();
      useAiSettingsStore.setState({ settings: null });
    });

    it("stops a Codex App Server turn with its captured project and session ids", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "cli",
          model: "gpt-5",
          cli: {
            kind: "codex",
            binaryPath: "/usr/bin/codex",
            model: "gpt-5",
            codexTransport: "app-server",
          },
        },
      });
      useChatStore.setState({
        sessions: [session1],
        activeProjectId: "proj-1",
        activeSessionId: session1.id,
        agentMode: false,
        ragEnabled: false,
      });
      mockSendCodexAppTurn.mockResolvedValue(() => {});

      const send = useChatStore.getState().sendMessage("Stop target");
      await vi.waitFor(() => expect(mockSendCodexAppTurn).toHaveBeenCalled());
      const payload = mockSendCodexAppTurn.mock.calls[0]?.[0];
      useChatStore.setState({
        activeProjectId: "proj-2",
        activeSessionId: "session-2",
      });

      useChatStore.getState().stopGeneration();

      await vi.waitFor(() =>
        expect(codexAppApi.abortCodexAppTurn).toHaveBeenCalledWith({
          projectId: "proj-1",
          sessionId: session1.id,
          grimodexTurnId: payload?.grimodexTurnId,
        }),
      );
      await send;
      useAiSettingsStore.setState({ settings: null });
    });

    it("records normalized chat input drift with the immutable route/provider/project", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      });
      mockBuildSystemPrompt.mockReturnValueOnce({
        prompt: "telemetry system prompt",
        totalTokens: 42,
        layers: [],
        contextPlan: {
          requestId: "request-telemetry",
          items: [],
          decisions: [],
          usage: {
            candidateTokens: 0,
            selectedTokens: 0,
            trimmedTokens: 0,
            budgetTokens: 1_000,
          },
          digest: "ctx-telemetry",
        },
      });
      mockSendChatMessageStream.mockImplementation(
        async (_messages, _params, callbacks: StreamCallbacks) => {
          callbacks.onTextDelta("ok");
          callbacks.onDone({
            stopReason: "end_turn",
            inputTokens: 50,
            outputTokens: 10,
            cacheReadTokens: 1_200,
            cacheWriteTokens: 300,
          });
          return () => {};
        },
      );

      await useChatStore.getState().sendMessage("テスト");

      const usage = mockRecordAiUsage.mock.calls.find(
        ([input]) => input.surface === "chat",
      )?.[0];
      expect(usage).toMatchObject({
        provider: "anthropic",
        projectId: "proj-1",
        tokensIn: 50,
        cacheReadTokens: 1_200,
        cacheWriteTokens: 300,
      });
      const drift = usage?.metadata?.["inputTokenDrift"] as
        | Record<string, unknown>
        | undefined;
      expect(drift).toMatchObject({
        scope: "chat",
        provider: "anthropic",
        projectId: "proj-1",
        estimatorFamily: "o200k_base",
        language: "ja",
        safetyMarginTokens: 32,
        contextPlanDigest: expect.stringMatching(/^ctx-/),
        normalizedActualInputTokens: 1_550,
        requestCount: 1,
        route: expect.objectContaining({
          surface: "chat",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          toolProtocol: "native",
        }),
      });
      expect(drift?.["deltaInputTokens"]).toBe(
        1_550 - Number(drift?.["estimatedInputTokens"]),
      );
    });

    it("非エージェント送信は chatModelOverride(一時モデル)を transport へ渡し、既定モデルは書き換えない", async () => {
      // 回帰: 一時モデルが送信に効かず既定へフォールバックしていた(非エージェント
      // 経路で override を transport に渡し忘れていた)バグの gate。
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "openai",
          model: "default-model",
        },
        models: [],
        chatModelOverride: "temp-model",
      });
      mockStreamResponse("ok");

      await useChatStore.getState().sendMessage("テスト");

      // sendChatMessageStream の第 7 引数(0-indexed 6)が送信モデル。
      const call = mockSendChatMessageStream.mock.calls.at(-1);
      expect(call?.[6]).toBe("temp-model");
      // 既定チャットモデルは一時選択で書き換わらない。
      expect(useAiSettingsStore.getState().settings?.model).toBe(
        "default-model",
      );

      useAiSettingsStore.setState({ settings: null, chatModelOverride: null });
    });

    it("別プロバイダ override は transport へ provider+variant を糸通しし、設定の既定を書き換えない", async () => {
      // 別プロバイダのモデルを composer ピッカーで選んだとき、その 1 送信だけ
      // 別プロバイダ(provider)+解決済み経路(apiVariant)で送る。グローバル設定は不変。
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "openai",
          model: "default-model",
        },
        models: [],
        chatModelOverride: "fugu",
        chatProviderOverride: "sakana",
        chatModelVariantOverride: "responses",
      });
      mockStreamResponse("ok");

      await useChatStore.getState().sendMessage("テスト");

      const call = mockSendChatMessageStream.mock.calls.at(-1);
      // 第7引数(idx6)=model, 第8引数(idx7)=provider, 第5引数(idx4)=apiVariant。
      expect(call?.[6]).toBe("fugu");
      expect(call?.[7]).toBe("sakana");
      expect(call?.[4]).toBe("responses");
      // 別プロバイダ一時選択は active 設定(provider/model)を書き換えない。
      expect(useAiSettingsStore.getState().settings?.provider).toBe("openai");
      expect(useAiSettingsStore.getState().settings?.model).toBe(
        "default-model",
      );

      useAiSettingsStore.setState({
        settings: null,
        chatModelOverride: null,
        chatProviderOverride: null,
        chatModelVariantOverride: null,
      });
    });

    it("同一プロバイダの一時モデルは transport の provider 引数を null(既定)に保つ", async () => {
      // 回帰: 別プロバイダ機能の追加で、同一プロバイダ override が provider を
      // 渡してしまわない(=従来挙動の byte-identical なキャッシュ温存)ことの gate。
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "openai",
          model: "default-model",
        },
        models: [],
        chatModelOverride: "temp-model",
        chatProviderOverride: null,
        chatModelVariantOverride: null,
      });
      mockStreamResponse("ok");

      await useChatStore.getState().sendMessage("テスト");

      const call = mockSendChatMessageStream.mock.calls.at(-1);
      expect(call?.[6]).toBe("temp-model");
      expect(call?.[7] ?? null).toBeNull();

      useAiSettingsStore.setState({ settings: null, chatModelOverride: null });
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

    it("publishes streaming draft without replacing the confirmed messages array", async () => {
      let frame: FrameRequestCallback | null = null;
      vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn((callback: FrameRequestCallback) => {
          frame = callback;
          return 1;
        }),
      );
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      let callbacks!: StreamCallbacks;
      mockSendChatMessageStream.mockImplementation(
        async (_messages, _params, capturedCallbacks) => {
          callbacks = capturedCallbacks;
          return () => {};
        },
      );

      try {
        const send = useChatStore.getState().sendMessage("テスト");
        await vi.waitFor(() => expect(callbacks).toBeDefined());
        const confirmedMessages = useChatStore.getState().messages;

        callbacks.onTextDelta("生成中");
        expect(frame).not.toBeNull();
        (frame as unknown as FrameRequestCallback)(16);

        expect(useChatStore.getState().messages).toBe(confirmedMessages);
        expect(useChatStore.getState().streamingDraft).toEqual({
          messageId: confirmedMessages[1].id,
          content: "生成中",
        });

        callbacks.onDone({ stopReason: "end_turn" });
        await send;
        expect(useChatStore.getState().messages).not.toBe(confirmedMessages);
        expect(useChatStore.getState().messages[1].content).toBe("生成中");
        expect(useChatStore.getState().streamingDraft).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
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

    it("flushes a buffered final frame before Stop invalidates the turn", async () => {
      vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn(() => 1),
      );
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      let callbacks!: StreamCallbacks;
      mockSendChatMessageStream.mockImplementation(
        async (_messages, _params, capturedCallbacks) => {
          callbacks = capturedCallbacks;
          return () => {};
        },
      );
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        messages: [],
      });

      try {
        const send = useChatStore.getState().sendMessage("テスト");
        await vi.waitFor(() => expect(callbacks).toBeDefined());
        callbacks.onTextDelta("停止直前の末尾");

        useChatStore.getState().stopGeneration();
        expect(useChatStore.getState().messages.at(-1)?.content).toBe(
          "停止直前の末尾",
        );

        await send;
        expect(chatApi.addMessage).toHaveBeenCalledWith(
          session1.id,
          "user",
          "テスト",
          expect.objectContaining({ id: expect.any(String) }),
        );
        expect(chatApi.addMessage).toHaveBeenCalledWith(
          session1.id,
          "assistant",
          "停止直前の末尾",
          expect.objectContaining({
            metadata: JSON.stringify({ stopped: true }),
          }),
        );

        // A late backend abort error is idempotent after synthetic Stop
        // finalization and cannot erase/persist the turn twice.
        callbacks.onError("stopped");
        expect(chatApi.addMessage).toHaveBeenCalledTimes(2);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("preserves a stopped agent turn when the in-flight transport rejects", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "openrouter",
          model: "openrouter/anthropic/claude-sonnet-4.6",
        },
      });
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        messages: [],
        agentMode: true,
      });

      let rejectSecondCall!: (error: Error) => void;
      mockSendAgentMessage
        .mockResolvedValueOnce({
          blocks: [
            { type: "text", content: "途中回答" },
            {
              type: "tool_use",
              id: "tool-1",
              name: "undeclared_tool",
              input: {},
            },
          ],
          stopReason: "tool_use",
        })
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              rejectSecondCall = reject;
            }),
        );

      try {
        const sendPromise = useChatStore.getState().sendMessage("調べて");
        await vi.waitFor(() => {
          expect(useChatStore.getState().messages.at(-1)?.content).toBe(
            "途中回答",
          );
        });

        useChatStore.getState().stopGeneration();
        rejectSecondCall(new Error("aborted by stop"));
        await sendPromise;

        const state = useChatStore.getState();
        expect(state.isStreaming).toBe(false);
        expect(state.error).toBeNull();
        expect(state.messages.map((message) => message.content)).toEqual([
          "調べて",
          "途中回答",
        ]);
        expect(
          JSON.parse(state.messages.at(-1)?.metadata ?? "{}"),
        ).toMatchObject({ stopped: true });
        expect(chatApi.addMessage).toHaveBeenCalledWith(
          session1.id,
          "user",
          "調べて",
          expect.objectContaining({ id: expect.any(String) }),
        );
        const assistantPersistCall = vi
          .mocked(chatApi.addMessage)
          .mock.calls.find(
            (call) => call[0] === session1.id && call[1] === "assistant",
          );
        expect(assistantPersistCall?.[2]).toBe("途中回答");
        expect(assistantPersistCall?.[3]).toMatchObject({
          id: expect.any(String),
        });
        expect(
          JSON.parse(
            String(
              (assistantPersistCall?.[3] as { metadata?: string } | undefined)
                ?.metadata ?? "{}",
            ),
          ),
        ).toMatchObject({ stopped: true });
      } finally {
        useChatStore.setState({ agentMode: false, ragEnabled: false });
        useAiSettingsStore.setState({ settings: null });
      }
    });

    it("public RAGはprivate historyを除外しつつcommandInstructionを保持する", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "openrouter",
          model: "openrouter/anthropic/claude-sonnet-4.6",
        },
      });
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        messages: [makeMessage("assistant", "PRIVATE HISTORY")],
        agentMode: false,
        ragEnabled: true,
      });
      mockSendAgentMessage.mockResolvedValueOnce({
        blocks: [{ type: "text", content: "public answer" }],
        stopReason: "end_turn",
      });

      try {
        await useChatStore
          .getState()
          .sendMessage("public question", "TRUSTED COMMAND INSTRUCTION");

        const sentMessages = mockSendAgentMessage.mock.calls.at(-1)?.[0] ?? [];
        expect(sentMessages).toContainEqual({
          role: "system",
          content: expect.stringContaining("TRUSTED COMMAND INSTRUCTION"),
        });
        expect(sentMessages).toContainEqual({
          role: "user",
          content: "public question",
        });
        expect(JSON.stringify(sentMessages)).not.toContain("PRIVATE HISTORY");
      } finally {
        useChatStore.setState({ agentMode: false, ragEnabled: false });
        useAiSettingsStore.setState({ settings: null });
      }
    });

    it("accumulates parent and research Agent drift without changing aggregate tokens", async () => {
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      });
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        messages: [],
        agentMode: true,
        ragEnabled: false,
      });
      mockBuildSystemPrompt.mockReturnValueOnce({
        prompt: "agent telemetry system prompt",
        totalTokens: 42,
        layers: [],
        contextPlan: {
          requestId: "request-agent-telemetry",
          items: [],
          decisions: [],
          usage: {
            candidateTokens: 0,
            selectedTokens: 0,
            trimmedTokens: 0,
            budgetTokens: 1_000,
          },
          digest: "ctx-agent-telemetry",
        },
      });
      mockSendAgentMessage
        .mockResolvedValueOnce({
          blocks: [
            {
              type: "tool_use",
              id: "research-1",
              name: "run_research",
              input: { task: "moon archives" },
            },
          ],
          stopReason: "tool_use",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 100,
          cacheWriteTokens: 20,
        })
        .mockResolvedValueOnce({
          blocks: [{ type: "text", content: "research findings" }],
          stopReason: "end_turn",
          inputTokens: 30,
          outputTokens: 6,
          cacheReadTokens: 200,
          cacheWriteTokens: 40,
        })
        .mockResolvedValueOnce({
          blocks: [{ type: "text", content: "final answer" }],
          stopReason: "end_turn",
          inputTokens: 20,
          outputTokens: 7,
          cacheReadTokens: 300,
          cacheWriteTokens: 60,
        });

      try {
        await useChatStore.getState().sendMessage("調べて");

        const agentUsage = mockRecordAiUsage.mock.calls
          .map(([input]) => input)
          .filter((input) => input.surface === "agent");
        const byScope = new Map(
          agentUsage.map((input) => {
            const drift = input.metadata?.["inputTokenDrift"] as Record<
              string,
              unknown
            >;
            return [drift["scope"], { input, drift }];
          }),
        );
        const research = byScope.get("agent-research");
        const parent = byScope.get("agent-parent");

        expect(research?.input).toMatchObject({
          provider: "anthropic",
          projectId: "proj-1",
          tokensIn: 30,
          tokensOut: 6,
          cacheReadTokens: 200,
          cacheWriteTokens: 40,
        });
        expect(research?.drift).toMatchObject({
          contextPlanDigest: null,
          language: "ja",
          normalizedActualInputTokens: 270,
          requestCount: 1,
        });
        expect(parent?.input).toMatchObject({
          provider: "anthropic",
          projectId: "proj-1",
          // Existing Agent aggregate semantics stay as raw provider input sums.
          tokensIn: 30,
          tokensOut: 12,
          cacheReadTokens: 400,
          cacheWriteTokens: 80,
        });
        expect(parent?.drift).toMatchObject({
          contextPlanDigest: expect.stringMatching(/^ctx-/),
          language: "ja",
          normalizedActualInputTokens: 510,
          requestCount: 2,
          safetyMarginTokens: 64,
        });
        expect(parent?.drift["deltaInputTokens"]).toBe(
          510 - Number(parent?.drift["estimatedInputTokens"]),
        );
      } finally {
        useChatStore.setState({ agentMode: false, ragEnabled: false });
        useAiSettingsStore.setState({ settings: null });
      }
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

      const { contextTokenCount, contextPlan } = useChatStore.getState();
      expect(contextTokenCount).toBe(100);
      expect(contextPlan).toMatchObject({
        items: [],
        decisions: [],
      });
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

    it("snapshots scene authority before async reads during send", async () => {
      const { getNode, loadSceneContent } = await import("@/features/tree/api");
      const mockGetNode = vi.mocked(getNode);
      const mockLoadScene = vi.mocked(loadSceneContent);
      let resolveNode!: (node: {
        id: string;
        title: string;
        synopsis: string;
      }) => void;

      mockGetNode.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveNode = resolve;
        }) as never,
      );
      mockLoadScene.mockResolvedValueOnce("切替前シーンの本文");
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "snapshot prompt",
        totalTokens: 10,
        layers: [],
      });
      mockStreamResponse("回答");
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        chatScope: "scene",
        includeBodies: true,
      });

      const sendPromise = useChatStore.getState().sendMessage("質問");
      expect(useChatStore.getState().isStreaming).toBe(true);

      // The user may navigate or toggle eco mode while source IO is pending.
      // The in-flight turn must still use the authority captured at invocation.
      useChatStore.setState({
        activeSceneId: "scene-2",
        includeBodies: false,
      });
      resolveNode({
        id: "scene-1",
        title: "切替前シーン",
        synopsis: "切替前の要約",
      });

      await sendPromise;

      expect(mockGetNode).toHaveBeenCalledWith("scene-1");
      const args = mockBuildSystemPrompt.mock.calls.at(-1)?.[0];
      expect(args?.scene).toMatchObject({
        id: "scene-1",
        title: "切替前シーン",
        content: "切替前シーンの本文",
      });
    });

    it("does not start a transport after Stop during context preparation", async () => {
      let releaseTokenizer!: () => void;
      vi.mocked(contextBuilder.ensureTokenizer).mockReturnValueOnce(
        new Promise<void>((resolve) => {
          releaseTokenizer = resolve;
        }),
      );
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        chatScope: "scene",
      });

      const sendPromise = useChatStore.getState().sendMessage("止める質問");
      expect(useChatStore.getState().isStreaming).toBe(true);
      useChatStore.getState().stopGeneration();
      releaseTokenizer();

      await sendPromise;

      expect(mockSendChatMessageStream).not.toHaveBeenCalled();
      expect(useChatStore.getState().messages).toEqual([]);
      expect(useChatStore.getState().streamingDraft).toBeNull();
      expect(useChatStore.getState().isStreaming).toBe(false);
    });

    it("keeps a replacement turn authoritative when the stopped pre-transport turn resumes", async () => {
      let releaseFirstTokenizer!: () => void;
      vi.mocked(contextBuilder.ensureTokenizer).mockReturnValueOnce(
        new Promise<void>((resolve) => {
          releaseFirstTokenizer = resolve;
        }),
      );
      let replacementCallbacks!: StreamCallbacks;
      mockSendChatMessageStream.mockImplementation(
        async (_messages, _params, callbacks) => {
          replacementCallbacks = callbacks;
          return () => {};
        },
      );
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        messages: [],
      });

      const firstSend = useChatStore.getState().sendMessage("古い質問");
      useChatStore.getState().stopGeneration();
      const replacementSend = useChatStore.getState().sendMessage("新しい質問");
      await vi.waitFor(() => {
        expect(mockSendChatMessageStream).toHaveBeenCalledOnce();
      });

      releaseFirstTokenizer();
      await firstSend;

      expect(useChatStore.getState().isStreaming).toBe(true);
      expect(
        useChatStore.getState().messages.map((message) => message.content),
      ).toEqual(["新しい質問", ""]);

      replacementCallbacks.onTextDelta("新しい回答");
      replacementCallbacks.onDone({ stopReason: "end_turn" });
      await replacementSend;
      expect(useChatStore.getState().messages.at(-1)?.content).toBe(
        "新しい回答",
      );
    });

    it("ignores late callbacks from a stopped stream after a replacement starts", async () => {
      const callbacks: StreamCallbacks[] = [];
      mockSendChatMessageStream.mockImplementation(
        async (_messages, _params, streamCallbacks) => {
          callbacks.push(streamCallbacks);
          return () => {};
        },
      );
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        messages: [],
      });

      const firstSend = useChatStore.getState().sendMessage("古い質問");
      await vi.waitFor(() => expect(callbacks).toHaveLength(1));
      useChatStore.getState().stopGeneration();
      const replacementSend = useChatStore.getState().sendMessage("新しい質問");
      await vi.waitFor(() => expect(callbacks).toHaveLength(2));

      callbacks[0].onError("古いターンの遅延エラー");
      await firstSend;

      expect(useChatStore.getState().isStreaming).toBe(true);
      expect(useChatStore.getState().error).toBeNull();
      expect(
        useChatStore
          .getState()
          .messages.slice(-2)
          .map((message) => message.content),
      ).toEqual(["新しい質問", ""]);

      callbacks[1].onTextDelta("新しい回答");
      callbacks[1].onDone({ stopReason: "end_turn" });
      await replacementSend;
      expect(useChatStore.getState().messages.at(-1)?.content).toBe(
        "新しい回答",
      );
    });

    it("does not publish or persist a summary after the turn loses authority", async () => {
      const history = Array.from({ length: 5 }, (_, index) => [
        makeMessage("user", `user-${index}`, `user-${index}`),
        makeMessage("assistant", `assistant-${index}`, `assistant-${index}`),
      ]).flat();
      vi.mocked(contextBuilder.allocateLayerBudgets).mockReturnValueOnce({
        responseReservation: 1,
        l1: 1,
        l2: 1,
        l3: 1,
        l4: 1,
        l5: 1,
        degraded: false,
      });
      let resolveSummary!: (value: ChatMessageResult) => void;
      vi.mocked(chatApi.sendChatMessageWithThinking).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSummary = resolve;
        }),
      );
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        messages: history,
        summaryCount: 0,
      });

      const send = useChatStore.getState().sendMessage("要約を発火する質問");
      await vi.waitFor(() => {
        expect(chatApi.sendChatMessageWithThinking).toHaveBeenCalledOnce();
      });
      useChatStore.getState().stopGeneration();
      const replacement = [makeMessage("user", "replacement", "replacement")];
      useChatStore.setState({ messages: replacement, summaryCount: 0 });
      resolveSummary({
        text: "old summary",
        thinkingBlocks: [],
        inputTokens: 1,
        outputTokens: 1,
      });
      await send;

      expect(chatApi.addSummary).not.toHaveBeenCalled();
      expect(chatApi.markMessagesSummarized).not.toHaveBeenCalled();
      expect(useChatStore.getState().messages).toEqual(replacement);
      expect(useChatStore.getState().summaryCount).toBe(0);
    });

    it("fails closed when a stale scene id resolves to another project", async () => {
      const { getNode, loadSceneContent } = await import("@/features/tree/api");
      vi.mocked(getNode).mockResolvedValueOnce({
        id: "scene-1",
        projectId: "foreign-project",
        title: "別プロジェクトのシーン",
      } as never);
      vi.mocked(loadSceneContent).mockResolvedValueOnce("漏れてはいけない本文");
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        chatScope: "scene",
      });

      await useChatStore.getState().sendMessage("質問");

      expect(mockSendChatMessageStream).not.toHaveBeenCalled();
      expect(mockBuildSystemPrompt).not.toHaveBeenCalled();
      expect(useChatStore.getState().error).toContain(
        "scene context project mismatch",
      );
    });

    it("fails closed when required project context cannot be loaded", async () => {
      const { getProject } = await import("@/features/project/api");
      vi.mocked(getProject).mockRejectedValueOnce(new Error("project db down"));
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        messages: [],
      });

      await useChatStore.getState().sendMessage("質問");

      expect(mockSendChatMessageStream).not.toHaveBeenCalled();
      expect(useChatStore.getState().messages).toEqual([]);
      expect(useChatStore.getState().error).toBe(
        "required project context is unavailable",
      );
    });

    it("aborts send when the selected scene cannot be loaded", async () => {
      const { getNode } = await import("@/features/tree/api");
      vi.mocked(getNode).mockResolvedValueOnce(null as never);
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        activeSceneId: "missing-scene",
        activeProjectId: "proj-1",
        chatScope: "scene",
      });

      await useChatStore.getState().sendMessage("質問");

      expect(mockSendChatMessageStream).not.toHaveBeenCalled();
      expect(useChatStore.getState().error).toContain(
        "required scene context is unavailable",
      );
    });

    it("rejects a captured map board that belongs to another project", async () => {
      const { getMapBoard } = await import("@/features/map/mapApi");
      vi.mocked(getMapBoard).mockResolvedValueOnce({
        id: "foreign-board",
        projectId: "foreign-project",
        title: "Foreign secrets",
      } as never);
      mockBuildSystemPrompt.mockReturnValueOnce({
        prompt: "safe prompt",
        totalTokens: 1,
        layers: [],
      });
      mockStreamResponse("回答");
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        chatScope: "scene",
        includeMapBoard: true,
        mapBoardId: "foreign-board",
      });

      await useChatStore.getState().sendMessage("質問");

      expect(
        mockBuildSystemPrompt.mock.calls.at(-1)?.[0].mapBoardMarkdown,
      ).toBe(undefined);
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
    it("fails closed when the captured session belongs to another project", async () => {
      useChatStore.setState({
        sessions: [{ ...session1, projectId: "foreign-project" }],
        activeSessionId: session1.id,
        activeSceneId: "",
        activeProjectId: "proj-1",
        chatScope: "project",
      });

      await useChatStore.getState().sendMessage("テスト");

      expect(mockSendChatMessageStream).not.toHaveBeenCalled();
      expect(useChatStore.getState().error).toBe(
        "chat session project mismatch",
      );
    });

    it("sendMessage rebuilds instead of trusting lastSystemPrompt when no scene", async () => {
      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: null,
        lastSystemPrompt: "フォールバックプロンプト",
      });
      mockBuildSystemPrompt.mockReturnValueOnce({
        prompt: "ターン専用プロンプト",
        totalTokens: 1,
        layers: [],
      });
      mockStreamResponse("回答");

      await useChatStore.getState().sendMessage("テスト");

      const passedMessages = mockSendChatMessageStream.mock.calls[0][0];
      expect(passedMessages[0].role).toBe("system");
      expect(passedMessages[0].content).toBe("ターン専用プロンプト");
    });

    it("uses the exact non-scene planner result instead of reading UI prompt state", async () => {
      const realRefresh = useChatStore.getState().refreshContextLayers;
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        activeSceneId: "",
        activeProjectId: "proj-1",
        chatScope: "project",
        lastSystemPrompt: "OLD UI PROMPT",
        refreshContextLayers: async () => {
          // Simulate another UI refresh overwriting the display cache before
          // the send continuation resumes.
          useChatStore.setState({ lastSystemPrompt: "OTHER UI PROMPT" });
          return {
            prompt: "DIRECT TURN PROMPT",
            totalTokens: 1,
            layers: [],
            contextPlan: {} as never,
            cacheSegments: ["DIRECT CACHE"],
            volatileTail: "DIRECT TAIL",
            fullyInjectedIds: [],
          };
        },
      });
      mockStreamResponse("回答");

      try {
        await useChatStore.getState().sendMessage("テスト");
      } finally {
        useChatStore.setState({ refreshContextLayers: realRefresh });
      }

      const call = mockSendChatMessageStream.mock.calls[0];
      expect(call[0][0]).toMatchObject({
        role: "system",
        content: "DIRECT TURN PROMPT",
      });
      expect(call[3]).toEqual(["DIRECT CACHE"]);
      expect(call[5]).toBe("DIRECT TAIL");
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
          threadFocusOverride: null,
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

    it("sendMessage rebuilds even when the UI prompt key still matches", async () => {
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
      mockBuildSystemPrompt.mockReturnValueOnce({
        prompt: "FRESH TURN PROMPT",
        totalTokens: 1,
        layers: [],
      });
      mockStreamResponse("回答");

      await useChatStore.getState().sendMessage("テスト");

      const passedMessages = mockSendChatMessageStream.mock.calls[0][0];
      expect(passedMessages[0].role).toBe("system");
      expect(passedMessages[0].content).toBe("FRESH TURN PROMPT");
      expect(mockBuildSystemPrompt).toHaveBeenCalled();
    });

    it("captures non-scene map selection at the send click", async () => {
      const { getMapBoard } = await import("@/features/map/mapApi");
      let releaseTokenizer!: () => void;
      vi.mocked(contextBuilder.ensureTokenizer).mockReturnValueOnce(
        new Promise<void>((resolve) => {
          releaseTokenizer = resolve;
        }),
      );
      mockBuildSystemPrompt.mockReturnValueOnce({
        prompt: "captured project prompt",
        totalTokens: 1,
        layers: [],
      });
      mockStreamResponse("回答");
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        activeSceneId: "",
        activeProjectId: "proj-1",
        chatScope: "project",
        includeMapBoard: false,
        mapBoardId: null,
      });

      const send = useChatStore.getState().sendMessage("テスト");
      useChatStore.setState({
        includeMapBoard: true,
        mapBoardId: "board-late",
      });
      releaseTokenizer();
      await send;

      expect(getMapBoard).not.toHaveBeenCalled();
      expect(
        mockBuildSystemPrompt.mock.calls.at(-1)?.[0].mapBoardMarkdown,
      ).toBe(undefined);
    });

    it("captures the non-scene active tab at the send click", async () => {
      const { getSnippet } = await import("@/features/snippets/api");
      let releaseTokenizer!: () => void;
      vi.mocked(contextBuilder.ensureTokenizer).mockReturnValueOnce(
        new Promise<void>((resolve) => {
          releaseTokenizer = resolve;
        }),
      );
      vi.mocked(getSnippet).mockResolvedValueOnce({
        id: "snippet-captured",
        projectId: "proj-1",
        title: "Captured Snippet",
        content: "captured body",
      } as never);
      mockBuildSystemPrompt.mockReturnValueOnce({
        prompt: "captured active-tab prompt",
        totalTokens: 1,
        layers: [],
      });
      mockStreamResponse("回答");
      useTabStore.setState({
        tabs: [
          {
            nodeId: "snippet-captured",
            contentType: "snippet",
            isPreview: false,
          },
        ],
        activeTabId: "snippet-captured",
      });
      useChatStore.setState({
        sessions: [session1],
        activeSessionId: session1.id,
        activeSceneId: "",
        activeProjectId: "proj-1",
        chatScope: "project",
      });

      const send = useChatStore.getState().sendMessage("テスト");
      useTabStore.setState({
        tabs: [
          {
            nodeId: "snippet-late",
            contentType: "snippet",
            isPreview: false,
          },
        ],
        activeTabId: "snippet-late",
      });
      releaseTokenizer();
      await send;

      expect(getSnippet).toHaveBeenCalledWith("proj-1", "snippet-captured");
      expect(
        mockBuildSystemPrompt.mock.calls.at(-1)?.[0].activeTabContent,
      ).toEqual({
        type: "snippet",
        title: "Captured Snippet",
        content: "Captured Snippet",
      });
    });

    it("does not let an older same-key refresh overwrite the newer result", async () => {
      const { getProject } = await import("@/features/project/api");
      let resolveOldProject!: (value: {
        id: string;
        title: string;
        language: string;
      }) => void;
      vi.mocked(getProject)
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveOldProject = resolve;
          }) as never,
        )
        .mockResolvedValueOnce({
          id: "proj-1",
          title: "New Project",
          language: "ja",
        } as never);
      mockBuildSystemPrompt
        .mockReturnValueOnce({
          prompt: "NEW REFRESH",
          totalTokens: 2,
          layers: [],
        })
        .mockReturnValueOnce({
          prompt: "OLD REFRESH",
          totalTokens: 1,
          layers: [],
        });
      useChatStore.setState({
        sessions: [],
        activeSessionId: null,
        activeSceneId: "",
        activeProjectId: "proj-1",
        chatScope: "project",
      });

      const oldRefresh = useChatStore
        .getState()
        .refreshContextLayers({ purpose: "live" });
      await vi.waitFor(() => expect(getProject).toHaveBeenCalledTimes(1));
      await useChatStore.getState().refreshContextLayers({ purpose: "live" });
      resolveOldProject({
        id: "proj-1",
        title: "Old Project",
        language: "ja",
      });
      await oldRefresh;

      expect(useChatStore.getState().lastSystemPrompt).toBe("NEW REFRESH");
      expect(useChatStore.getState().contextTokenCount).toBe(2);
    });

    it("clears stale prompt state and aborts send when non-scene planning fails", async () => {
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      vi.mocked(listCodexEntriesForContext).mockRejectedValueOnce(
        new Error("source unavailable"),
      );
      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        activeSessionId: "session-1",
        chatScope: "project",
        scopeAnchorId: null,
        lastSystemPrompt: "STALE OTHER PROJECT PROMPT",
        lastSystemPromptKey: "stale-key",
      });

      await useChatStore.getState().sendMessage("テスト");

      expect(mockSendChatMessageStream).not.toHaveBeenCalled();
      expect(useChatStore.getState().lastSystemPrompt).toBe("");
      expect(useChatStore.getState().lastSystemPromptKey).toBeNull();
    });

    it("buildPromptForCopy rebuilds instead of reading lastSystemPrompt", async () => {
      mockBuildSystemPrompt.mockReturnValueOnce({
        prompt: "FRESH GLOBAL COPY",
        totalTokens: 2,
        layers: [],
      });
      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        lastSystemPrompt: "STALE PROMPT",
        messages: [],
      });

      const result = await useChatStore
        .getState()
        .buildPromptForCopy("ユーザー入力");

      expect(result).toContain("[system]\nFRESH GLOBAL COPY");
      expect(result).not.toContain("STALE PROMPT");
      expect(result).toContain("[user]\nユーザー入力");
    });

    it("buildPromptForCopy never falls back to stale state after planning fails", async () => {
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      vi.mocked(listCodexEntriesForContext).mockRejectedValueOnce(
        new Error("source unavailable"),
      );
      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        lastSystemPrompt: "STALE PROMPT",
        messages: [],
      });

      const result = await useChatStore
        .getState()
        .buildPromptForCopy("ユーザー入力");

      expect(result).not.toContain("[system]");
      expect(result).not.toContain("STALE PROMPT");
      expect(result).toContain("[user]\nユーザー入力");
    });

    it("buildPromptForCopy rebuilds a project-scope TurnRequest", async () => {
      mockBuildSystemPrompt.mockClear();
      mockBuildSystemPrompt.mockReturnValueOnce({
        prompt: "FRESH PROJECT COPY",
        totalTokens: 2,
        layers: [],
      });
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

      expect(result).toContain("[system]\nFRESH PROJECT COPY");
      expect(result).not.toContain("集約済みプロンプト");
      expect(mockBuildSystemPrompt).toHaveBeenCalled();
    });

    it("captures scene scope before tokenizer initialization during copy", async () => {
      const { getNode } = await import("@/features/tree/api");
      let releaseTokenizer!: () => void;
      vi.mocked(contextBuilder.ensureTokenizer).mockReturnValueOnce(
        new Promise<void>((resolve) => {
          releaseTokenizer = resolve;
        }),
      );
      mockBuildSystemPrompt.mockReturnValueOnce({
        prompt: "SCENE COPY",
        totalTokens: 1,
        layers: [],
      });
      useChatStore.setState({
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        chatScope: "scene",
        messages: [],
      });

      const copyPromise = useChatStore
        .getState()
        .buildPromptForCopy("ユーザー入力");
      useChatStore.setState({ activeSceneId: "scene-2" });
      releaseTokenizer();

      await copyPromise;

      expect(vi.mocked(getNode)).toHaveBeenCalledWith("scene-1");
    });

    it("buildPromptForCopy refreshes context when lastSystemPrompt is empty in project scope", async () => {
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
    it("treats every visible direct child of a DB-pinned withChildren parent as an explicit child pin", async () => {
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
        readings: null,
        summary: "A-summary",
        content: "{}",
        icon: null,
        tagsCache: null,
        contextMode: "mentioned",
        childrenBudget: "compact",
        sourceChatMessageId: null,
        notes: null,
        version: 0,
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
        contextMode: "always",
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
      const detected = args?.codexEntries ?? [];
      const parentCtx = pinned.find((p) => p.id === "A");
      const childCtx = detected.find((entry) => entry.id === "X");

      expect(parentCtx).toBeDefined();
      expect(childCtx).toBeUndefined();

      // withChildren は直下子を個別の explicit selection として扱うため、
      // current mention の有無に関係なく X/Y は full child block になる。
      expect(parentCtx?.children?.map((c) => c.id) ?? []).toEqual(
        expect.arrayContaining(["X", "Y"]),
      );
      // direct child の summary は childrenContext に重ねて出さない。
      expect(parentCtx?.childrenContext ?? "").not.toContain("X-summary");
      expect(parentCtx?.childrenContext ?? "").not.toContain("Y-summary");
    });

    it("resolves non-scene mentions from the captured project tree", async () => {
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent, loadSceneContents } =
        await import("@/features/tree/api");
      const mockTreeState = vi.mocked(useTreeStore.getState);
      const capturedScene = {
        id: "mentioned-scene",
        projectId: "proj-1",
        parentId: null,
        nodeType: "scene" as const,
        title: "Captured title",
        sortOrder: "a0",
        synopsis: null,
        charCount: 10,
      };
      mockTreeState
        .mockReturnValueOnce({ nodes: [capturedScene] } as ReturnType<
          typeof useTreeStore.getState
        >)
        .mockReturnValue({ nodes: [] } as unknown as ReturnType<
          typeof useTreeStore.getState
        >);
      vi.mocked(listCodexEntriesForContext).mockResolvedValue([]);
      vi.mocked(loadSceneContent).mockResolvedValue("captured body");
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "captured prompt",
        totalTokens: 10,
        layers: [],
      });
      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "project",
        scopeAnchorId: null,
      });

      await useChatStore
        .getState()
        .refreshContextLayers({ mentionedSceneIds: [capturedScene.id] });

      expect(
        mockBuildSystemPrompt.mock.calls.at(-1)?.[0]?.mentionedScenes,
      ).toEqual([
        {
          id: capturedScene.id,
          title: "Captured title",
          content: "captured body",
        },
      ]);
      expect(vi.mocked(loadSceneContents)).toHaveBeenCalledWith([
        capturedScene.id,
      ]);
    });
  });

  // --- Phase 2: folder scope での子シーン本文集約 ---

  describe("refreshContextLayers folder scope aggregation", () => {
    it("aggregates descendant scene bodies and detects codex from joined text", async () => {
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent, loadSceneContents } =
        await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
      const mockLoadScene = vi.mocked(loadSceneContent);
      const mockLoadScenes = vi.mocked(loadSceneContents);
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
        readings: null,
        summary: "ヒロイン",
        content: "{}",
        icon: null,
        tagsCache: null,
        contextMode: "mentioned",
        phaseLabel: null,
        notes: null,
        childrenBudget: "compact",
        sourceChatMessageId: null,
        version: 0,
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
      expect(mockLoadScenes).toHaveBeenCalledOnce();
      expect(mockLoadScenes).toHaveBeenCalledWith(["sA", "sB"]);

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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent, loadSceneFull, loadScenesFull } =
        await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent, loadSceneFull } =
        await import("@/features/tree/api");
      const { useSettingsStore } =
        await import("@/features/settings/settingsStore");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneFull } = await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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

    it("snapshots conversation history before scene refresh awaits", async () => {
      const { getNode, loadSceneContent } = await import("@/features/tree/api");
      let resolveNode!: (node: { id: string; title: string }) => void;
      vi.mocked(getNode).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveNode = resolve;
        }) as never,
      );
      vi.mocked(loadSceneContent).mockResolvedValueOnce("本文");
      const mockCountTokens = vi.mocked(contextBuilder.countTokens);
      mockCountTokens.mockClear();
      useChatStore.setState({
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        chatScope: "scene",
        includeBodies: true,
        messages: [makeMessage("user", "refresh 開始前の履歴", "before")],
      });

      const refreshPromise = useChatStore.getState().refreshContextLayers();
      useChatStore.setState({
        messages: [makeMessage("user", "refresh 開始後の履歴", "after")],
      });
      resolveNode({ id: "scene-1", title: "テストシーン" });

      await refreshPromise;

      expect(mockCountTokens).toHaveBeenCalledWith("refresh 開始前の履歴");
      expect(mockCountTokens).not.toHaveBeenCalledWith("refresh 開始後の履歴");
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

    it("非 scene スコープ: 検索せずpreview TurnRequestを再構築する", async () => {
      const { semanticSearch } = await import("@/features/semantic-search/api");
      const mockSearch = vi.mocked(semanticSearch);
      mockSearch.mockClear();
      mockBuildSystemPrompt.mockReturnValueOnce({
        prompt: "PREVIEW PROJECT PROMPT",
        totalTokens: 8,
        layers: [],
      });
      const liveContextPlan = { requestId: "live-context-plan" } as never;

      useChatStore.setState({
        activeSceneId: "",
        activeProjectId: "proj-1",
        chatScope: "project",
        scopeAnchorId: null,
        lastSystemPrompt: "LIVE PROJECT PROMPT",
        contextLayers: [],
        contextTokenCount: 99,
        contextPlan: liveContextPlan,
      });

      const result = await useChatStore.getState().buildPreviewPrompt();

      expect(mockSearch).not.toHaveBeenCalled();
      expect(result).toEqual({
        status: "ready",
        prompt: "PREVIEW PROJECT PROMPT",
        layers: [],
        totalTokens: 8,
        userMessage: "",
      });
      expect(useChatStore.getState().lastSystemPrompt).toBe(
        "LIVE PROJECT PROMPT",
      );
      expect(useChatStore.getState().contextPlan).toBe(liveContextPlan);
    });

    it("scene が取得不能なら live-estimate cache を返さず unavailable にする", async () => {
      const { getNode } = await import("@/features/tree/api");
      vi.mocked(getNode).mockResolvedValueOnce(undefined);
      useChatStore.setState({
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "scene",
        scopeAnchorId: null,
        lastSystemPrompt: "STALE LIVE ESTIMATE PROMPT",
        contextLayers: [],
        contextTokenCount: 999,
      });
      useChatStore.getState().registerInputDraftProvider(() => ({
        markdown: "未送信の入力",
        mentionedSceneIds: [],
        mentionedCodexIds: [],
      }));

      const result = await useChatStore.getState().buildPreviewPrompt();

      expect(result).toEqual({
        status: "unavailable",
        prompt: "",
        layers: [],
        totalTokens: 0,
        userMessage: "未送信の入力",
      });
      expect(result.prompt).not.toContain("STALE LIVE ESTIMATE PROMPT");
      expect(mockBuildSystemPrompt).not.toHaveBeenCalled();
    });

    it("exact preview の構築例外時も live-estimate cache を返さない", async () => {
      vi.mocked(contextBuilder.ensureTokenizer).mockRejectedValueOnce(
        new Error("tokenizer unavailable"),
      );
      useChatStore.setState({
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "scene",
        scopeAnchorId: null,
        lastSystemPrompt: "STALE LIVE ESTIMATE PROMPT",
        contextLayers: [],
        contextTokenCount: 999,
      });

      const result = await useChatStore.getState().buildPreviewPrompt();

      expect(result).toEqual({
        status: "unavailable",
        prompt: "",
        layers: [],
        totalTokens: 0,
        userMessage: "",
      });
      expect(result.prompt).not.toContain("STALE LIVE ESTIMATE PROMPT");
      expect(mockBuildSystemPrompt).not.toHaveBeenCalled();
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
        mentionedCodexIds: [],
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
        mentionedCodexIds: [],
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
        mentionedCodexIds: [],
      }));

      await useChatStore.getState().buildPreviewPrompt();

      // send は RAG 有効時 agent パス(agentMode:true)に入るので preview も揃える
      expect(mockBuildSystemPrompt.mock.calls.at(-1)?.[0]?.agentMode).toBe(
        true,
      );

      // プロバイダ設定を元に戻す(他テストへの漏れ防止)
      useAiSettingsStore.setState({ settings: prevSettings });
    });

    it("openrouter/fusion は agentMode/RAG が ON でも非エージェントで組む(tools を載せない)", async () => {
      // 回帰: fusion は tool-calling と両立できず、OpenRouter は tools[] 同梱時に
      // カスタムパネル(analysis_models)を無視して既定パネルに落とす。fusion 選択時は
      // 常に非エージェント経路へ通すこと(エージェントトグルが OFF にできない状態でも)。
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
      // resetStore() は agentMode/ragEnabled を戻さない(既存の分離ギャップ)ため、
      // 本テストで立てたフラグが後続 describe へ漏れないよう自前で退避・復元する。
      const prevAgentMode = useChatStore.getState().agentMode;
      const prevRagEnabled = useChatStore.getState().ragEnabled;
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "openrouter",
          model: "openrouter/fusion",
        },
        chatModelOverride: null,
      });
      useChatStore.setState({
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "scene",
        scopeAnchorId: null,
        inputPinnedEntryIds: [],
        includeBodies: true,
        agentMode: true, // トグル ON でも…
        ragEnabled: true, // RAG ON でも…
        messages: [],
      });
      useChatStore.getState().registerInputDraftProvider(() => ({
        markdown: "質問",
        mentionedSceneIds: [],
        mentionedCodexIds: [],
      }));

      await useChatStore.getState().buildPreviewPrompt();

      // …fusion なので非エージェント(agentMode:false)で組まれること。
      expect(mockBuildSystemPrompt.mock.calls.at(-1)?.[0]?.agentMode).toBe(
        false,
      );

      useAiSettingsStore.setState({
        settings: prevSettings,
        chatModelOverride: null,
      });
      useChatStore.setState({
        agentMode: prevAgentMode,
        ragEnabled: prevRagEnabled,
      });
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent, loadSceneFull } =
        await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");
      const { useAiSettingsStore } = await import("./store");
      const { DEFAULT_AI_SETTINGS } = await import("./types");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContent } = await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
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

    it("Tier 1: a sparse batch does not kill the aggregate", async () => {
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { useTreeStore } = await import("@/features/tree/treeStore");
      const { loadSceneContents } = await import("@/features/tree/api");

      const mockListCodex = vi.mocked(listCodexEntriesForContext);
      const mockLoadScenes = vi.mocked(loadSceneContents);
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
      mockLoadScenes.mockResolvedValue(
        new Map([
          ["s0", "body:s0"],
          ["s2", "body:s2"],
        ]),
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
      expect(mockLoadScenes).toHaveBeenCalledOnce();
      expect(mockLoadScenes).toHaveBeenCalledWith(["s0", "s1", "s2"]);
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
      useChatStore.setState({
        chatScope: "codex",
        scopeAnchorId: "codex-1",
      });
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

    it("preserves session state when the exact scope and anchor are unchanged", () => {
      const snippetSession = {
        ...session1,
        nodeId: null,
        snippetAnchorId: "snip-1",
      };
      useChatStore.setState({
        chatScope: "snippet",
        scopeAnchorId: "snip-1",
        sessions: [snippetSession],
        activeSessionId: snippetSession.id,
        messages: [msg1],
        summaryCount: 2,
        maxSummaryGeneration: 1,
      });

      useChatStore.getState().setChatScope("snippet", "snip-1");

      expect(useChatStore.getState()).toMatchObject({
        sessions: [snippetSession],
        activeSessionId: snippetSession.id,
        messages: [msg1],
        summaryCount: 2,
        maxSummaryGeneration: 1,
      });
    });

    it("falls back to scene when snippet anchor is missing", () => {
      useChatStore.getState().setChatScope("snippet");
      const s = useChatStore.getState();
      expect(s.chatScope).toBe("scene");
      expect(s.includeBodies).toBe(true);
    });

    it("loadSessions passes snippetAnchorId to chatApi", async () => {
      mockListSessions.mockResolvedValueOnce([]);
      useChatStore.setState({
        chatScope: "snippet",
        scopeAnchorId: "sn-1",
      });
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

    // Phase 3b: 非永続スレッド focus は session 保存先（resolveScopeSessionKey 経由）を
    // 変えてはいけない。下地 scope（scene）の nodeId のまま createSession される。
    it("threadFocusOverride does not change the session save target (scene scope)", async () => {
      mockCreateSession.mockResolvedValueOnce({
        ...session1,
        id: "new-thread-session",
        nodeId: "scene-7",
      });
      useChatStore.setState({
        activeSessionId: null,
        chatScope: "scene",
        scopeAnchorId: null,
        activeSceneId: "scene-7",
        activeProjectId: "proj-1",
        threadFocusOverride: { threadId: "thread-1", title: "Aの真実" },
      });
      await useChatStore.getState().ensureSession();
      expect(mockCreateSession).toHaveBeenCalledWith(
        "proj-1",
        "New session",
        "scene-7",
        undefined,
        undefined,
      );
    });

    it("contextPromptKey changes with threadFocusOverride but keeps other fields", () => {
      const base = {
        chatScope: "scene" as const,
        scopeAnchorId: null,
        activeSceneId: "scene-7",
        activeSessionId: "session-1",
      };
      const without = contextPromptKey({ ...base, threadFocusOverride: null });
      const withFocus = contextPromptKey({
        ...base,
        threadFocusOverride: { threadId: "thread-1", title: "Aの真実" },
      });
      expect(withFocus).not.toBe(without);
      // 下地スコープ識別子は両者で共通（session 保存先は不変）。
      expect(withFocus.startsWith("scene")).toBe(true);
      expect(without.startsWith("scene")).toBe(true);
    });

    it("setChatScope clears a non-persistent threadFocusOverride", () => {
      useChatStore.setState({
        chatScope: "scene",
        threadFocusOverride: { threadId: "thread-1", title: "Aの真実" },
      });
      useChatStore.getState().setChatScope("project");
      expect(useChatStore.getState().threadFocusOverride).toBeNull();
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
      const snippetSession = {
        ...session1,
        nodeId: null,
        snippetAnchorId: "snip-1",
      };
      useChatStore.setState({
        chatScope: "snippet",
        scopeAnchorId: "snip-1",
        includeBodies: false,
        sessions: [snippetSession],
        activeSessionId: snippetSession.id,
        messages: [msg1],
        summaryCount: 1,
      });
      useChatStore.getState().onSnippetAnchorDeleted("snip-1");
      const s = useChatStore.getState();
      expect(s.chatScope).toBe("scene");
      expect(s.scopeAnchorId).toBeNull();
      expect(s.includeBodies).toBe(true);
      expect(s.sessions).toEqual([]);
      expect(s.activeSessionId).toBeNull();
      expect(s.messages).toEqual([]);
      expect(s.summaryCount).toBe(0);
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
        version: 0,
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
        version: 0,
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
      const codexSession = {
        ...session1,
        nodeId: null,
        codexAnchorId: "codex-hero",
      };
      useChatStore.setState({
        chatScope: "codex",
        scopeAnchorId: "codex-hero",
        includeBodies: false,
        sessions: [codexSession],
        activeSessionId: codexSession.id,
        messages: [msg1],
        maxSummaryGeneration: 2,
      });
      useChatStore.getState().onCodexAnchorDeleted("codex-hero");
      const s = useChatStore.getState();
      expect(s.chatScope).toBe("scene");
      expect(s.scopeAnchorId).toBeNull();
      expect(s.includeBodies).toBe(true);
      expect(s.sessions).toEqual([]);
      expect(s.activeSessionId).toBeNull();
      expect(s.messages).toEqual([]);
      expect(s.maxSummaryGeneration).toBe(0);
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
      readings: null,
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      vi.mocked(listCodexEntriesForContext).mockResolvedValue([
        alwaysEntry,
      ] as never);

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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      vi.mocked(listCodexEntriesForContext).mockResolvedValue([
        alwaysEntry,
      ] as never);
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
      const { listCodexEntriesForContext } =
        await import("@/features/codex/api");
      const { findMentionedEntriesAsync } =
        await import("@/features/codex/rustMatcher");
      const detEntry = {
        ...alwaysEntry,
        id: "det-1",
        name: "検出キャラ",
        contextMode: "mentioned",
      };
      vi.mocked(listCodexEntriesForContext).mockResolvedValue([
        detEntry,
      ] as never);
      vi.mocked(findMentionedEntriesAsync).mockImplementation(() =>
        Promise.resolve([
          {
            id: "det-1",
            name: "検出キャラ",
            type: "character",
            aliases: null,
            excludedAliases: null,
            readings: null,
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

  // --------------------------------------------------------------------------
  // chat episodic recall トグル (ai.chatRecall) の挙動 gate。
  // OFF にすると過去対話の意味検索 (fetchChatRecall → chatMessageSearch) は走らず、
  // scene RAG (fetchSemanticRecall → semanticSearch) はそのまま走る。recall の独立性を
  // 下位検索 API の call-count で固定する (どちらも @/features/semantic-search/api で
  // mock 済みの別シーム — fetchChatRecall=chatMessageSearch / fetchSemanticRecall=
  // semanticSearch を呼ぶ)。
  // (レビュー所見: 現状インライン guard のみで未テスト)
  // --------------------------------------------------------------------------
  describe("ai.chatRecall トグルが episodic recall を独立にゲートする", () => {
    let useSettingsStore: typeof import("@/features/settings/settingsStore").useSettingsStore;
    let useTreeStore: typeof import("@/features/tree/treeStore").useTreeStore;
    let mockTreeState: ReturnType<
      typeof vi.mocked<typeof useTreeStore.getState>
    >;
    // 過去対話 (episodic) recall = chatMessageSearch / scene RAG = semanticSearch。
    let mockChatMessageSearch: ReturnType<typeof vi.fn>;
    let mockSemanticSearch: ReturnType<typeof vi.fn>;

    async function setupRecallScene(chatRecall: boolean) {
      ({ useSettingsStore } =
        await import("@/features/settings/settingsStore"));
      ({ useTreeStore } = await import("@/features/tree/treeStore"));
      const searchApi = await import("@/features/semantic-search/api");
      mockTreeState = vi.mocked(useTreeStore.getState);
      mockChatMessageSearch = vi.mocked(searchApi.chatMessageSearch);
      mockSemanticSearch = vi.mocked(searchApi.semanticSearch);
      mockChatMessageSearch.mockClear();
      mockSemanticSearch.mockClear();

      // 両 recall とも projectIdForFs を要求する。既定 mock は projectId 無しで
      // 早期に空へ落ちるため、ここで projectId を持たせて recall 経路を起動可能にする。
      mockTreeState.mockReturnValue({
        nodes: [],
        projectId: "proj-1",
        // テスト用 stub: nodes/projectId 以外のフィールドは本経路で未使用。
      } as unknown as ReturnType<typeof useTreeStore.getState>);

      // scene RAG は常に ON、chat recall だけ test ごとに切替える。
      useSettingsStore.setState((s) => ({
        cache: {
          ...s.cache,
          "ai.semanticRecall": "true",
          "ai.chatRecall": chatRecall ? "true" : "false",
        },
      }));

      mockStreamResponse("ok");
    }

    function restoreSettings() {
      // 後続テストへ漏らさないよう既定 (どちらも ON) へ戻す。
      useSettingsStore.setState((s) => ({
        cache: {
          ...s.cache,
          "ai.semanticRecall": "true",
          "ai.chatRecall": "true",
        },
      }));
      mockTreeState.mockReturnValue({
        nodes: [],
      } as unknown as ReturnType<typeof useTreeStore.getState>);
    }

    it("ai.chatRecall=false なら episodic recall は走らず scene RAG は走る", async () => {
      await setupRecallScene(false);
      try {
        await useChatStore.getState().sendMessage("過去の話を思い出して");

        // episodic recall (過去対話の意味検索) は抑止される。
        expect(mockChatMessageSearch).not.toHaveBeenCalled();
        // scene RAG (シーンの意味検索) は据え置きで走る。
        expect(mockSemanticSearch).toHaveBeenCalled();
      } finally {
        restoreSettings();
      }
    });

    it("ai.chatRecall=true (既定) なら episodic recall も走る", async () => {
      await setupRecallScene(true);
      try {
        await useChatStore.getState().sendMessage("過去の話を思い出して");

        expect(mockChatMessageSearch).toHaveBeenCalled();
        expect(mockSemanticSearch).toHaveBeenCalled();
      } finally {
        restoreSettings();
      }
    });
  });

  // --------------------------------------------------------------------------
  // 送信先 (provider/apiVariant/endpoint) の優先順位を transport payload で固定する:
  //   composer cross-provider override (xprov) > per-role override > active(null)。
  // 非エージェント会話ストリーム経路 (sendChatMessageStream) で観測する。
  // role override は aiModel.role.conversation + aiModel.roleProviders で構成する。
  // (レビュー所見: インライン三項のみで未テスト)
  // --------------------------------------------------------------------------
  describe("送信先 override の優先順位 (xprov > role > active)", () => {
    let useSettingsStore: typeof import("@/features/settings/settingsStore").useSettingsStore;

    // sendChatMessageStream 引数: [4]=apiVariant, [6]=model, [7]=provider, [8]=endpointId。
    const A_VARIANT = 4;
    const A_MODEL = 6;
    const A_PROVIDER = 7;
    const A_ENDPOINT = 8;

    async function setConversationRole(
      model: string | null,
      provider: string | null,
      endpointId: string | null,
    ) {
      ({ useSettingsStore } =
        await import("@/features/settings/settingsStore"));
      const roleProviders =
        provider || endpointId
          ? JSON.stringify({
              conversation: {
                ...(provider ? { provider } : {}),
                ...(endpointId ? { endpointId } : {}),
              },
            })
          : "";
      useSettingsStore.setState((s) => ({
        cache: {
          ...s.cache,
          // conversation ロール (= chat_stream_non_agent) のモデル割り当て。
          "aiModel.role.conversation": model ?? "",
          "aiModel.roleProviders": roleProviders,
        },
      }));
    }

    function restoreRole() {
      useSettingsStore.setState((s) => ({
        cache: {
          ...s.cache,
          "aiModel.role.conversation": "",
          "aiModel.roleProviders": "",
        },
      }));
    }

    beforeEach(() => {
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "openai",
          model: "default-model",
        },
        models: [],
        chatModelOverride: null,
        chatProviderOverride: null,
        chatModelVariantOverride: null,
      });
      // 既存セッションを確立して auto-create (createSession mock=undefined で 3221 throw)
      // を回避する。session が無いと前テストの stale stream call を拾い flaky 化する。
      // agentMode/ragEnabled は resetStore で戻されず前テスト (agent 系) から漏れる。
      // どちらかが true だと agent 経路 (sendAgentMessage) に逸れて非エージェント
      // ストリーム経路を観測できないため、ここで明示的に false へ固定する。
      useChatStore.setState({
        activeSessionId: "session-1",
        sessions: [session1],
        agentMode: false,
        ragEnabled: false,
      });
      mockStreamResponse("ok");
    });

    afterEach(() => {
      restoreRole();
      useAiSettingsStore.setState({
        settings: null,
        chatModelOverride: null,
        chatProviderOverride: null,
        chatModelVariantOverride: null,
      });
    });

    it("composer override と role override が両方あれば composer (xprov) が勝つ", async () => {
      // per-role: openrouter (別経路) を割り当てておく。
      await setConversationRole("role-model", "openrouter", null);
      // composer cross-provider: sakana/fugu (variant=responses) を選択。
      useAiSettingsStore.setState({
        chatModelOverride: "fugu",
        chatProviderOverride: "sakana",
        chatModelVariantOverride: "responses",
      });

      await useChatStore.getState().sendMessage("テスト");

      const call = mockSendChatMessageStream.mock.calls.at(-1);
      // composer override が provider/model/variant を総取りする。
      expect(call?.[A_PROVIDER]).toBe("sakana");
      expect(call?.[A_MODEL]).toBe("fugu");
      expect(call?.[A_VARIANT]).toBe("responses");
    });

    it("role override のみなら role の provider/variant/endpoint が乗る", async () => {
      // openai-compatible + 別エンドポイント。variant は overrideApiVariantForProvider
      // 由来 (openai-compatible は null=backend 既定)。
      await setConversationRole(
        "role-model",
        "openai-compatible",
        "endpoint-7",
      );

      await useChatStore.getState().sendMessage("テスト");

      const call = mockSendChatMessageStream.mock.calls.at(-1);
      expect(call?.[A_PROVIDER]).toBe("openai-compatible");
      expect(call?.[A_MODEL]).toBe("role-model");
      expect(call?.[A_ENDPOINT]).toBe("endpoint-7");
      // openai-compatible は variant override を持たない (null)。
      expect(call?.[A_VARIANT] ?? null).toBeNull();
    });

    it("role override が sakana なら variant=responses が解決される", async () => {
      await setConversationRole("role-model", "sakana", null);

      await useChatStore.getState().sendMessage("テスト");

      const call = mockSendChatMessageStream.mock.calls.at(-1);
      expect(call?.[A_PROVIDER]).toBe("sakana");
      expect(call?.[A_MODEL]).toBe("role-model");
      expect(call?.[A_VARIANT]).toBe("responses");
    });

    it("composer も role も無ければ payload は active (provider/endpoint=null)", async () => {
      // role モデルだけ割り当てて provider は付けない = active provider 据え置き。
      await setConversationRole(null, null, null);

      await useChatStore.getState().sendMessage("テスト");

      const call = mockSendChatMessageStream.mock.calls.at(-1);
      expect(call?.[A_PROVIDER] ?? null).toBeNull();
      expect(call?.[A_ENDPOINT] ?? null).toBeNull();
    });
  });
});
