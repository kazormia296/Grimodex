// DA-2b の PUB-G 前の必須 3（DR-DA2B-R22）の C：行を挿入する chat の書込みのうち、会話の
// 作成（新しい会話、関連付けた会話〔system の行つき〕、`ensureSession` の作成の分岐）と
// A/B の採用は、定数が true で閉なら repository を呼ばずに理由を示す。既にある会話の
// `ensureSession` は今のまま。定数が false の間は閉の状態があっても今のまま。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ enabled: true }));
const toastInfo = vi.hoisted(() => vi.fn());

vi.mock("@/features/profile-egress/profileActivationAvailability", () => ({
  get PROFILE_ACTIVATION_UI_ENABLED() {
    return flags.enabled;
  },
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    info: toastInfo,
    error: vi.fn(),
    success: vi.fn(),
  }),
}));

import { createChatSessionStoreActions } from "./chatSessionStoreActions";
import { createChatPersistenceStoreActions } from "./chatPersistenceStoreActions";
import type { ChatState } from "./chatStoreTypes";
import { useAiSettingsStore } from "@/features/chat/store";
import type { ChatSession } from "@/features/chat/chatTypes";

function session(id: string): ChatSession {
  return {
    id,
    projectId: "p1",
    title: "New session",
    titleManual: 0,
    model: "",
    nodeId: null,
    codexAnchorId: null,
    snippetAnchorId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as ChatSession;
}

function setup(activeSessionId: string | null = null) {
  let state = {
    activeProjectId: "p1",
    activeSceneId: "",
    chatScope: "project",
    scopeAnchorId: null,
    activeSessionId,
    sessions: activeSessionId ? [session(activeSessionId)] : [],
    messages: [],
    isStreaming: false,
    isLoadingSessions: false,
  } as unknown as ChatState;
  const set = (partial: unknown) => {
    state = {
      ...state,
      ...(typeof partial === "function"
        ? (partial as (s: ChatState) => Partial<ChatState>)(state)
        : (partial as Partial<ChatState>)),
    };
  };
  const get = () => state;
  const repository = {
    listSessions: vi.fn(),
    getSessionForProject: vi.fn(),
    createSession: vi.fn(async () => session("created")),
    deleteSession: vi.fn(),
    listMessages: vi.fn(),
    listSummaries: vi.fn(),
    addSystemMessage: vi.fn(),
    archiveSessionThread: vi.fn(),
    clearProjectChatHistory: vi.fn(),
  };
  const runtime = {
    snapshotAgentTools: () => null as never,
    resetRecallPromote: vi.fn(),
    hasPendingCompletedTurnPersistence: () => false,
    translate: (key: string) => key,
    notifyError: vi.fn(),
    reportError: vi.fn(),
    reportWarning: vi.fn(),
  };
  const sessions = createChatSessionStoreActions({
    set: set as never,
    get,
    repository,
    runtime,
  });
  const persistence = {
    addMessage: vi.fn(),
    saveMessagePrompt: vi.fn(),
    deleteMessages: vi.fn(),
  };
  const persistenceRuntime = {
    hasPendingCompletedTurnPersistence: () => false,
    hasPendingCompletedTurnPersistenceForMessage: () => false,
    notifyPendingCompletedTurnPersistence: vi.fn(),
    notifySaveFailure: vi.fn(),
    notifyDeleteFailure: vi.fn(),
    reportError: vi.fn(),
    reportWarning: vi.fn(),
    parseMentionedSceneIds: () => undefined,
  };
  const ensureSession = vi.fn(async () => "s1");
  const adopt = createChatPersistenceStoreActions({
    set: set as never,
    get: () => ({ ...state, ensureSession }) as ChatState,
    repository: persistence,
    runtime: persistenceRuntime,
  });
  return {
    sessions,
    adopt,
    repository,
    runtime,
    persistence,
    persistenceRuntime,
    ensureSession,
    state: () => state,
  };
}

const AB = {
  userDraft: "draft",
  basePrompt: "",
  mentionedSceneIds: [] as string[],
  assistantText: "answer",
  model: null,
};

beforeEach(() => {
  flags.enabled = true;
  toastInfo.mockReset();
  useAiSettingsStore.setState({ profileEgressClosed: true });
});

afterEach(() => {
  useAiSettingsStore.setState({ profileEgressClosed: undefined });
});

describe("閉のとき（定数 true）", () => {
  it("ensureSession は会話を作らず、理由を示して null を返す", async () => {
    const { sessions, repository, runtime, state } = setup();
    await expect(sessions.ensureSession()).resolves.toBeNull();
    expect(repository.createSession).not.toHaveBeenCalled();
    expect(runtime.notifyError).toHaveBeenCalledWith(
      "profileEgress.chat.newConversationClosed",
    );
    expect(state().activeSessionId).toBeNull();
  });

  it("既にある会話の ensureSession は今のまま返す", async () => {
    const { sessions, repository, runtime } = setup("s1");
    await expect(sessions.ensureSession()).resolves.toBe("s1");
    expect(repository.createSession).not.toHaveBeenCalled();
    expect(runtime.notifyError).not.toHaveBeenCalled();
  });

  it("新しい会話は作らず、理由を示す", async () => {
    const { sessions, repository, runtime } = setup();
    await sessions.createNewSession("p1", "New session");
    expect(repository.createSession).not.toHaveBeenCalled();
    expect(runtime.notifyError).toHaveBeenCalledWith(
      "profileEgress.chat.newConversationClosed",
    );
  });

  it("関連付けた会話は作らず、system の行も足さない", async () => {
    const { sessions, repository, runtime } = setup("s1");
    await sessions.createLinkedSession();
    expect(repository.createSession).not.toHaveBeenCalled();
    expect(repository.addSystemMessage).not.toHaveBeenCalled();
    expect(runtime.notifyError).toHaveBeenCalledWith(
      "profileEgress.chat.newConversationClosed",
    );
  });

  it("A/B の採用は会話を作らず行も足さず、理由を示して false を返す", async () => {
    const { adopt, persistence, persistenceRuntime, ensureSession } =
      setup("s1");
    await expect(adopt.appendAdoptedAbTurn(AB)).resolves.toBe(false);
    expect(ensureSession).not.toHaveBeenCalled();
    expect(persistence.addMessage).not.toHaveBeenCalled();
    expect(persistenceRuntime.notifySaveFailure).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith(
      expect.stringContaining("abAdoptClosed"),
    );
  });
});

describe("開のとき、または定数が false の間（今の製品）", () => {
  it.each([
    ["開", true, undefined],
    ["定数 false", false, true],
  ] as const)("%s：会話を作る", async (_label, enabled, closed) => {
    flags.enabled = enabled;
    useAiSettingsStore.setState({ profileEgressClosed: closed });
    const { sessions, repository, runtime } = setup();
    await expect(sessions.ensureSession()).resolves.toBe("created");
    await sessions.createNewSession("p1", "New session");
    expect(repository.createSession).toHaveBeenCalledTimes(2);
    expect(runtime.notifyError).not.toHaveBeenCalled();
  });

  it.each([
    ["開", true, undefined],
    ["定数 false", false, true],
  ] as const)(
    "%s：A/B の採用は今のまま進む",
    async (_label, enabled, closed) => {
      flags.enabled = enabled;
      useAiSettingsStore.setState({ profileEgressClosed: closed });
      const { adopt, ensureSession } = setup("s1");
      await adopt.appendAdoptedAbTurn(AB);
      expect(ensureSession).toHaveBeenCalledOnce();
      expect(toastInfo).not.toHaveBeenCalled();
    },
  );
});
