// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// DA-2b の PUB-G 前の必須 1（DR-DA2B-R17）：場面の会話でない会話の「編集して再送」は、
// 定数（`PROFILE_ACTIVATION_UI_ENABLED`）に依らず、状態が `unrestricted` と読めたときだけ
// 進む。restricted・activating・unavailable・読取の失敗・未知の値では、DB の行を消さない。
// ここでは本物の定数（false）のまま、bridge の `get_profile_egress_status` の答えを変える。

const { toastInfo, toastError, deleteMessages } = vi.hoisted(() => ({
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  deleteMessages: vi.fn(async (_ids: string[]) => undefined),
}));
vi.mock("sonner", () => ({ toast: { info: toastInfo, error: toastError } }));
vi.mock("./chatApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chatApi")>()),
  deleteMessages,
}));
// 編集の後の mention の chip の復元（editor の stub は schema を持たない）。
const { restoreSceneMentionChips } = vi.hoisted(() => ({
  restoreSceneMentionChips: vi.fn(),
}));
vi.mock("./components/ChatInput", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./components/ChatInput")>()),
  restoreSceneMentionChips,
}));

import i18next from "@/lib/i18n";
import { PROFILE_ACTIVATION_UI_ENABLED } from "@/features/profile-egress/profileActivationAvailability";
import { useChatStore } from "./chatStore";
import { useChatMessageActions } from "./useChatMessageActions";
import {
  NON_SCENE_EDIT_STATUS_TIMEOUT_MS,
  registerPendingCommandReader,
  resetNonSceneEditClosureForTest,
} from "./chatEgressClosure";
import {
  configureCloudRoute,
  configureOpenaiCompatibleRoute,
} from "./editCaptureRoute.testSupport";

type Answer = () => Promise<unknown>;
const STATUS = "get_profile_egress_status";

function installBridge(answer: Answer) {
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd !== STATUS) throw new Error(`unexpected command ${cmd}`);
    return answer();
  });
  (window as unknown as { grimodex: unknown }).grimodex = {
    invoke,
    listen: vi.fn(() => () => undefined),
  };
  return invoke;
}

const ok =
  (value: unknown): Answer =>
  async () => ({ ok: true, value });

function seed(scope: "project" | "scene" | "folder" = "project") {
  useChatStore.setState({
    activeProjectId: "p1",
    activeSessionId: "s1",
    activeSceneId: scope === "scene" ? "scene-1" : "",
    chatScope: scope,
    scopeAnchorId: scope === "folder" ? "folder-1" : null,
    threadFocusOverride: null,
    isStreaming: false,
    messages: [
      {
        id: "u1",
        sessionId: "s1",
        role: "user",
        content: "question",
        createdAt: "2026-10-25T00:00:00.000Z",
      },
      {
        id: "a1",
        sessionId: "s1",
        role: "assistant",
        content: "answer",
        createdAt: "2026-10-25T00:00:01.000Z",
      },
    ] as never,
  });
}

/**
 * 本文を戻す先の editor（生きた stub）。入力欄（`ChatInput`）と同じく、保留中の slash
 * command の読取を登録する（既定は command なし。R32）。
 */
const pendingCommand = { current: undefined as string | undefined };
function liveEditor() {
  const editor = {
    isDestroyed: false,
    commands: { setContent: vi.fn(), focus: vi.fn() },
  };
  registerPendingCommandReader(editor, () => pendingCommand.current);
  return editor;
}

type EditorStub = ReturnType<typeof liveEditor>;
let editorRef: { current: EditorStub | null } = { current: null };

function renderActions(editor: EditorStub | null = liveEditor()) {
  editorRef = { current: editor };
  const { result } = renderHook(() =>
    useChatMessageActions({
      aiSettings: null,
      chatEditorRef: editorRef as never,
      syncInsertedToEditorMetadata: vi.fn(),
    }),
  );
  return result;
}

// 状態の wrapper は動的 import なので、最初の読込みを先に済ませておく。
beforeAll(async () => {
  await import("@/lib/profileEgressStatus");
});

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const closedShown = () =>
  vi.waitFor(() =>
    expect(toastError).toHaveBeenCalledWith(i18next.t("common.error")),
  );

describe("非場面の会話の編集して再送（本物の定数のまま）", () => {
  beforeEach(() => {
    resetNonSceneEditClosureForTest();
    pendingCommand.current = undefined;
    toastInfo.mockClear();
    toastError.mockClear();
    deleteMessages.mockClear();
  });
  afterEach(() => {
    delete (window as unknown as { grimodex?: unknown }).grimodex;
  });

  it("本物の定数は false", () => {
    expect(PROFILE_ACTIVATION_UI_ENABLED).toBe(false);
  });

  it.each([
    ["restricted", ok({ state: "restricted" })],
    ["activating", ok({ state: "activating" })],
    [
      "unavailable",
      ok({ state: "unavailable", reason: "state-file-unreadable" }),
    ],
    ["未知の state", ok({ state: "open" })],
    ["余分な key", ok({ state: "unrestricted", extra: 1 })],
    ["envelope の失敗", async () => ({ ok: false, error: "x" })],
    [
      "読取の例外",
      async () => {
        throw new Error("ipc down");
      },
    ],
  ] as Array<[string, Answer]>)(
    "%s では行を消さず、一般の文を出す",
    async (_label, answer) => {
      const invoke = installBridge(answer);
      seed("project");
      const result = renderActions();
      result.current.handleEditMessage("u1");
      await closedShown();
      await flush();
      expect(deleteMessages).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(useChatStore.getState().messages.map((m) => m.id)).toEqual([
        "u1",
        "a1",
      ]);
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastInfo).not.toHaveBeenCalled();
    },
  );

  it("folder の scope（anchor あり）も非場面として閉じる", async () => {
    const invoke = installBridge(ok({ state: "restricted" }));
    seed("folder");
    renderActions().current.handleEditMessage("u1");
    await closedShown();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(deleteMessages).not.toHaveBeenCalled();
  });

  it("unrestricted なら今のとおり編集する（往復 1 回）", async () => {
    const invoke = installBridge(ok({ state: "unrestricted" }));
    seed("project");
    renderActions().current.handleEditMessage("u1");
    await vi.waitFor(() =>
      expect(deleteMessages).toHaveBeenCalledWith(["u1", "a1"]),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().messages).toEqual([]);
    expect(editorRef.current?.commands.setContent).toHaveBeenCalledWith(
      "question",
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  // 最終受入れの P2-1（DR-DA2B-R21）：本文を戻す先が無いまま行だけを消さない。
  it.each([
    ["非場面の会話（unrestricted）", "project"],
    ["場面の会話（同期）", "scene"],
  ] as Array<[string, "project" | "scene"]>)(
    "%sで editor が無ければ行を消さない",
    async (_label, scope) => {
      installBridge(ok({ state: "unrestricted" }));
      seed(scope);
      renderActions(null).current.handleEditMessage("u1");
      await flush();
      expect(deleteMessages).not.toHaveBeenCalled();
      expect(useChatStore.getState().messages).toHaveLength(2);
    },
  );

  it.each([
    [
      "破棄された",
      () => {
        if (editorRef.current) editorRef.current.isDestroyed = true;
      },
    ],
    [
      "null になった（ChatPanel を閉じた）",
      () => {
        editorRef.current = null;
      },
    ],
  ] as Array<[string, () => void]>)(
    "読取の間に editor が%sら、unrestricted でも行を消さない",
    async (_label, change) => {
      const gate = deferred();
      const invoke = installBridge(() => gate.promise);
      seed("project");
      const editor = liveEditor();
      renderActions(editor).current.handleEditMessage("u1");
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      change();
      gate.resolve({ ok: true, value: { state: "unrestricted" } });
      await flush();
      expect(deleteMessages).not.toHaveBeenCalled();
      expect(useChatStore.getState().messages).toHaveLength(2);
      expect(editor.commands.setContent).not.toHaveBeenCalled();
    },
  );

  it("場面の会話で route が capture の内なら状態を読まず、同期で編集する", () => {
    const invoke = installBridge(ok({ state: "restricted" }));
    configureOpenaiCompatibleRoute();
    seed("scene");
    renderActions().current.handleEditMessage("u1");
    expect(invoke).not.toHaveBeenCalled();
    expect(deleteMessages).toHaveBeenCalledWith(["u1", "a1"]);
  });

  it("場面の scope でも thread の focus 中は capture の外なので閉じる", async () => {
    const invoke = installBridge(ok({ state: "restricted" }));
    seed("scene");
    useChatStore.setState({
      threadFocusOverride: { threadId: "t1", title: "thread" },
    });
    renderActions().current.handleEditMessage("u1");
    await closedShown();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(deleteMessages).not.toHaveBeenCalled();
  });

  it("場面の scope でも場面が開いていなければ閉じる", async () => {
    const invoke = installBridge(ok({ state: "restricted" }));
    seed("scene");
    useChatStore.setState({ activeSceneId: "" });
    renderActions().current.handleEditMessage("u1");
    await closedShown();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(deleteMessages).not.toHaveBeenCalled();
  });

  it("restricted は保持し、2 回目は読まずに閉じる", async () => {
    const invoke = installBridge(ok({ state: "restricted" }));
    seed("project");
    const result = renderActions();
    result.current.handleEditMessage("u1");
    await closedShown();
    toastError.mockClear();
    result.current.handleEditMessage("u1");
    await closedShown();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(deleteMessages).not.toHaveBeenCalled();
  });

  it("restricted 以外の閉（activating）は保持しない", async () => {
    let answer: Answer = ok({ state: "activating" });
    const invoke = installBridge(() => answer());
    seed("project");
    const result = renderActions();
    result.current.handleEditMessage("u1");
    await closedShown();
    answer = ok({ state: "unrestricted" });
    result.current.handleEditMessage("u1");
    await vi.waitFor(() =>
      expect(deleteMessages).toHaveBeenCalledWith(["u1", "a1"]),
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("開と読取の失敗は保持しない（次の編集で読み直す）", async () => {
    let answer: Answer = async () => {
      throw new Error("ipc down");
    };
    const invoke = installBridge(() => answer());
    seed("project");
    const result = renderActions();
    result.current.handleEditMessage("u1");
    await closedShown();
    answer = ok({ state: "unrestricted" });
    result.current.handleEditMessage("u1");
    await vi.waitFor(() => expect(deleteMessages).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledTimes(2);
    seed("project");
    answer = ok({ state: "restricted" });
    result.current.handleEditMessage("u1");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    await flush();
    expect(deleteMessages).toHaveBeenCalledTimes(1);
  });

  it("読取の間の連打は 1 本にまとめる", async () => {
    const gate = deferred();
    const invoke = installBridge(() => gate.promise);
    seed("project");
    const result = renderActions();
    result.current.handleEditMessage("u1");
    result.current.handleEditMessage("u1");
    result.current.handleEditMessage("u1");
    gate.resolve({ ok: true, value: { state: "unrestricted" } });
    await vi.waitFor(() => expect(deleteMessages).toHaveBeenCalledTimes(1));
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(deleteMessages).toHaveBeenCalledTimes(1);
  });

  it("閉のときの連打も読取 1 本、表示 1 回にまとめる", async () => {
    const gate = deferred();
    const invoke = installBridge(() => gate.promise);
    seed("project");
    const result = renderActions();
    result.current.handleEditMessage("u1");
    result.current.handleEditMessage("u1");
    result.current.handleEditMessage("u1");
    gate.resolve({ ok: true, value: { state: "activating" } });
    await closedShown();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(deleteMessages).not.toHaveBeenCalled();
  });

  it.each([
    ["会話の切替", () => useChatStore.setState({ activeSessionId: "s2" })],
    [
      "workspace の切替",
      () => useChatStore.setState({ activeProjectId: "p2" }),
    ],
    ["stream の開始", () => useChatStore.setState({ isStreaming: true })],
    ["行が消えた", () => useChatStore.setState({ messages: [] as never })],
    [
      "後ろに assistant 行が足された（stream の完了）",
      () =>
        useChatStore.setState({
          messages: [
            ...useChatStore.getState().messages,
            {
              id: "a2",
              sessionId: "s1",
              role: "assistant",
              content: "late answer",
              createdAt: "2026-10-25T00:00:02.000Z",
            },
          ] as never,
        }),
    ],
    [
      "後ろに行が足された",
      () =>
        useChatStore.setState({
          messages: [
            ...useChatStore.getState().messages,
            {
              id: "u2",
              sessionId: "s1",
              role: "user",
              content: "later",
              createdAt: "2026-10-25T00:00:02.000Z",
            },
          ] as never,
        }),
    ],
    [
      "場面の会話への切替",
      () =>
        useChatStore.setState({ chatScope: "scene", activeSceneId: "scene-1" }),
    ],
  ] as Array<[string, () => void]>)(
    "読取の間の%sでは unrestricted でも編集しない",
    async (_label, change) => {
      const gate = deferred();
      const invoke = installBridge(() => gate.promise);
      seed("project");
      renderActions().current.handleEditMessage("u1");
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      change();
      gate.resolve({ ok: true, value: { state: "unrestricted" } });
      await flush();
      expect(deleteMessages).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
    },
  );

  it("読取が戻らなければ時間切れで閉にし、入口をふさがない", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let answer: Answer = () => new Promise(() => undefined);
      const invoke = installBridge(() => answer());
      seed("project");
      const result = renderActions();
      result.current.handleEditMessage("u1");
      await vi.advanceTimersByTimeAsync(NON_SCENE_EDIT_STATUS_TIMEOUT_MS - 1);
      expect(toastError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(toastError).toHaveBeenCalledWith(i18next.t("common.error"));
      expect(deleteMessages).not.toHaveBeenCalled();
      // 時間切れは保持しない。次の編集は読み直して進む。
      answer = ok({ state: "unrestricted" });
      result.current.handleEditMessage("u1");
      await vi.advanceTimersByTimeAsync(0);
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(deleteMessages).toHaveBeenCalledWith(["u1", "a1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bridge が無い（Electron の外）ときは unrestricted として編集する", async () => {
    seed("project");
    renderActions().current.handleEditMessage("u1");
    await vi.waitFor(() =>
      expect(deleteMessages).toHaveBeenCalledWith(["u1", "a1"]),
    );
  });
});

// DA-2b の PUB-G 前の必須 5（DR-DA2B-R29、表の 5 の案 (a)）：場面の会話でも、再送が
// capture の外になる route なら、非場面の会話と同じく状態を読み、unrestricted のときだけ進む。
describe("場面の会話で route が capture の外の編集して再送（本物の定数のまま）", () => {
  beforeEach(() => {
    resetNonSceneEditClosureForTest();
    pendingCommand.current = undefined;
    toastInfo.mockClear();
    toastError.mockClear();
    deleteMessages.mockClear();
    configureOpenaiCompatibleRoute();
  });
  afterEach(() => {
    delete (window as unknown as { grimodex?: unknown }).grimodex;
  });

  const outside: Array<[string, () => void]> = [
    ["cloud の provider", () => configureCloudRoute()],
    [
      "loopback でない OpenAI 互換",
      () => configureOpenaiCompatibleRoute("http://192.168.1.20:12345/v1"),
    ],
    ["agent", () => useChatStore.setState({ agentMode: true })],
    ["RAG", () => useChatStore.setState({ ragEnabled: true })],
    [
      "対象の行の scene の mention",
      () =>
        useChatStore.setState({
          messages: useChatStore.getState().messages.map((message) =>
            message.id === "u1"
              ? {
                  ...message,
                  metadata: JSON.stringify({
                    mentioned_scene_ids: ["scene-2"],
                  }),
                }
              : message,
          ),
        }),
    ],
  ];

  it.each(outside)(
    "%s では restricted で行を消さず、一般の文を出す",
    async (_label, arrange) => {
      const invoke = installBridge(ok({ state: "restricted" }));
      seed("scene");
      useChatStore.setState({ agentMode: false, ragEnabled: false });
      arrange();
      renderActions().current.handleEditMessage("u1");
      await closedShown();
      await flush();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(deleteMessages).not.toHaveBeenCalled();
      expect(useChatStore.getState().messages.map((m) => m.id)).toEqual([
        "u1",
        "a1",
      ]);
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastInfo).not.toHaveBeenCalled();
    },
  );

  it.each(outside)(
    "%s でも unrestricted なら今のとおり編集する（往復 1 回）",
    async (_label, arrange) => {
      const invoke = installBridge(ok({ state: "unrestricted" }));
      seed("scene");
      useChatStore.setState({ agentMode: false, ragEnabled: false });
      arrange();
      renderActions().current.handleEditMessage("u1");
      await vi.waitFor(() =>
        expect(deleteMessages).toHaveBeenCalledWith(["u1", "a1"]),
      );
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(toastError).not.toHaveBeenCalled();
    },
  );

  it("restricted を読めたら保持し、capture の外の 2 回目は読まずに閉じる", async () => {
    const invoke = installBridge(ok({ state: "restricted" }));
    configureCloudRoute();
    seed("scene");
    const result = renderActions();
    result.current.handleEditMessage("u1");
    await closedShown();
    toastError.mockClear();
    result.current.handleEditMessage("u1");
    await closedShown();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(deleteMessages).not.toHaveBeenCalled();
  });

  it("判定は click の時点：読取の間に capture の内の route へ切り替えても restricted なら閉じる", async () => {
    const gate = deferred();
    const invoke = installBridge(() => gate.promise);
    configureCloudRoute();
    seed("scene");
    renderActions().current.handleEditMessage("u1");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    configureOpenaiCompatibleRoute();
    gate.resolve({ ok: true, value: { state: "restricted" } });
    await closedShown();
    expect(deleteMessages).not.toHaveBeenCalled();
  });

  it("読取の間の会話の切替では、unrestricted でも編集せず通知もしない", async () => {
    const gate = deferred();
    const invoke = installBridge(() => gate.promise);
    configureCloudRoute();
    seed("scene");
    renderActions().current.handleEditMessage("u1");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    useChatStore.setState({ activeSessionId: "s2" });
    gate.resolve({ ok: true, value: { state: "unrestricted" } });
    await flush();
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("capture の外の連打は読取 1 本、表示 1 回にまとめる", async () => {
    const gate = deferred();
    const invoke = installBridge(() => gate.promise);
    configureCloudRoute();
    seed("scene");
    const result = renderActions();
    result.current.handleEditMessage("u1");
    result.current.handleEditMessage("u1");
    gate.resolve({ ok: true, value: { state: "restricted" } });
    await closedShown();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(deleteMessages).not.toHaveBeenCalled();
  });
});

// 独立レビューの P2-1（DR-DA2B-R32）：入力欄に保留中の slash command の指示は再送に付き、
// capture の外になる。loopback の場面の会話でも、restricted では行を消さない。
describe("保留中の slash command がある編集して再送（本物の定数のまま）", () => {
  beforeEach(() => {
    resetNonSceneEditClosureForTest();
    pendingCommand.current = undefined;
    toastError.mockClear();
    deleteMessages.mockClear();
    configureOpenaiCompatibleRoute();
  });
  afterEach(() => {
    delete (window as unknown as { grimodex?: unknown }).grimodex;
    pendingCommand.current = undefined;
  });

  it("保留中の command の指示があれば restricted で行を消さない", async () => {
    const invoke = installBridge(ok({ state: "restricted" }));
    seed("scene");
    useChatStore.setState({ agentMode: false, ragEnabled: false });
    pendingCommand.current = "brainstorm instruction";
    renderActions().current.handleEditMessage("u1");
    await closedShown();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(deleteMessages).not.toHaveBeenCalled();
  });

  it("保留中の command を読めない editor（未登録）なら閉の側（読取の経路）", async () => {
    const invoke = installBridge(ok({ state: "restricted" }));
    seed("scene");
    useChatStore.setState({ agentMode: false, ragEnabled: false });
    renderActions({
      isDestroyed: false,
      commands: { setContent: vi.fn(), focus: vi.fn() },
    }).current.handleEditMessage("u1");
    await closedShown();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(deleteMessages).not.toHaveBeenCalled();
  });
});
