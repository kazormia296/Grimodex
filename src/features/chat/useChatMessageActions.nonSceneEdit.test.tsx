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

import i18next from "@/lib/i18n";
import { PROFILE_ACTIVATION_UI_ENABLED } from "@/features/profile-egress/profileActivationAvailability";
import { useChatStore } from "./chatStore";
import { useChatMessageActions } from "./useChatMessageActions";
import { resetNonSceneEditClosureForTest } from "./chatEgressClosure";

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

function renderActions() {
  const { result } = renderHook(() =>
    useChatMessageActions({
      aiSettings: null,
      chatEditorRef: { current: null },
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
    expect(toastError).not.toHaveBeenCalled();
  });

  it("場面の会話では状態を読まず、同期で編集する", () => {
    const invoke = installBridge(ok({ state: "restricted" }));
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

  it("bridge が無い（Electron の外）ときは unrestricted として編集する", async () => {
    seed("project");
    renderActions().current.handleEditMessage("u1");
    await vi.waitFor(() =>
      expect(deleteMessages).toHaveBeenCalledWith(["u1", "a1"]),
    );
  });
});
