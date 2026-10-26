// @vitest-environment happy-dom
import { act, render, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// DA-2b の PUB-G 前の必須 1（DR-DA2B-R17）：入力欄の「最後の行の編集」（editLast の key）も、
// 場面の会話でないときは、定数に依らず状態が `unrestricted` と読めたときだけ進む。
// 本物の定数（false）のまま、bridge の `get_profile_egress_status` の答えを変える。

const h = vi.hoisted(() => {
  const editor = {
    isDestroyed: false,
    isEmpty: true,
    // Not mounted: the input never reads the view's DOM in this test.
    get view(): never {
      throw new Error("The editor view is not available");
    },
    on: vi.fn(),
    off: vi.fn(),
    setEditable: vi.fn(),
    getText: vi.fn(() => ""),
    storage: {},
    state: { doc: { descendants: vi.fn() } },
    commands: {
      clearContent: vi.fn(),
      focus: vi.fn(),
      setContent: vi.fn(),
    },
  };
  return {
    editor,
    onEditLast: { current: (() => {}) as () => void },
    setCommandPopup: { current: null as null | ((state: unknown) => void) },
    onCommandSelect: { current: null as null | ((cmd: unknown) => void) },
    toastError: vi.fn(),
    deleteMessages: vi.fn(async (_ids: string[]) => undefined),
  };
});

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: h.toastError, success: vi.fn() },
}));

vi.mock("../chatApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chatApi")>()),
  deleteMessages: h.deleteMessages,
}));

vi.mock("@tiptap/react", () => ({
  EditorContent: () => null,
  useEditor: () => h.editor,
  useEditorState: () => ({ hasText: false, text: "", hasMentions: false }),
}));

vi.mock("../extensions/chatInputExtensions", () => ({
  getChatInputExtensions: (options: {
    onEditLast: () => void;
    setCommandPopup: (state: unknown) => void;
  }) => {
    h.onEditLast.current = options.onEditLast;
    h.setCommandPopup.current = options.setCommandPopup;
    return [];
  },
}));

// slash command の選択（`handleCommandSelect`）を試験から呼ぶ。
vi.mock("./ChatCommandPopup", () => ({
  ChatCommandPopup: (props: { onSelect: (cmd: unknown) => void }) => {
    h.onCommandSelect.current = props.onSelect;
    return null;
  },
}));

vi.mock("@/features/editor/useCodexHighlight", () => ({
  useCodexHighlight: vi.fn(),
}));

vi.mock("@/features/editor/CodexPopover", () => ({
  CodexPopover: () => null,
}));

vi.mock("../useChatModelCatalog", () => ({
  useChatModelCatalog: () => ({ sections: [], loading: false }),
}));

import i18next from "@/lib/i18n";
import { PROFILE_ACTIVATION_UI_ENABLED } from "@/features/profile-egress/profileActivationAvailability";
import { useChatStore } from "../chatStore";
import { resetNonSceneEditClosureForTest } from "../chatEgressClosure";
import { ChatInput } from "./ChatInput";
import { useChatMessageActions } from "../useChatMessageActions";
import {
  configureCloudRoute,
  configureOpenaiCompatibleRoute,
} from "../editCaptureRoute.testSupport";

const STATUS = "get_profile_egress_status";

function installBridge(state: unknown) {
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd !== STATUS) throw new Error(`unexpected command ${cmd}`);
    return { ok: true, value: state };
  });
  (window as unknown as { grimodex: unknown }).grimodex = {
    invoke,
    listen: vi.fn(() => () => undefined),
  };
  return invoke;
}

function renderInput(
  scope: "project" | "scene",
  editorRef?: { current: unknown },
) {
  useChatStore.setState({
    agentMode: false,
    ragEnabled: false,
    activeProjectId: "p1",
    activeSessionId: "s1",
    activeSceneId: scope === "scene" ? "scene-1" : "",
    chatScope: scope,
    scopeAnchorId: null,
    threadFocusOverride: null,
    isStreaming: false,
    messages: [
      {
        id: "u1",
        sessionId: "s1",
        role: "user",
        content: "last question",
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
  render(<ChatInput onSend={vi.fn()} editorRef={editorRef as never} />);
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(async () => {
  await import("@/lib/profileEgressStatus");
});

describe("入力欄の最後の行の編集（本物の定数のまま）", () => {
  beforeEach(() => {
    resetNonSceneEditClosureForTest();
    h.editor.isDestroyed = false;
    h.editor.isEmpty = true;
    h.editor.commands.setContent.mockClear();
    h.toastError.mockClear();
    h.deleteMessages.mockClear();
    configureOpenaiCompatibleRoute();
  });
  afterEach(() => {
    delete (window as unknown as { grimodex?: unknown }).grimodex;
  });

  it("本物の定数は false", () => {
    expect(PROFILE_ACTIVATION_UI_ENABLED).toBe(false);
  });

  it.each([
    [{ state: "restricted" }],
    [{ state: "unavailable", reason: "status-invalid" }],
    [{ state: "bogus" }],
  ])("非場面の会話で %o なら行を消さない", async (state) => {
    const invoke = installBridge(state);
    renderInput("project");
    h.onEditLast.current();
    await vi.waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(i18next.t("common.error")),
    );
    await flush();
    expect(h.deleteMessages).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().messages).toHaveLength(2);
    expect(h.editor.commands.setContent).not.toHaveBeenCalled();
  });

  it("非場面の会話で unrestricted なら今のとおり編集する", async () => {
    const invoke = installBridge({ state: "unrestricted" });
    renderInput("project");
    h.onEditLast.current();
    await vi.waitFor(() =>
      expect(h.editor.commands.setContent).toHaveBeenCalledWith(
        "last question",
      ),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(h.deleteMessages).toHaveBeenCalledWith(["u1", "a1"]);
  });

  it("読取の間に最後の user 行が変わったら編集しない", async () => {
    let release!: () => void;
    const invoke = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ ok: true, value: { state: "unrestricted" } });
        }),
    );
    (window as unknown as { grimodex: unknown }).grimodex = {
      invoke,
      listen: vi.fn(() => () => undefined),
    };
    renderInput("project");
    h.onEditLast.current();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    useChatStore.setState({
      messages: [
        ...useChatStore.getState().messages,
        {
          id: "u2",
          sessionId: "s1",
          role: "user",
          content: "next",
          createdAt: "2026-10-25T00:00:02.000Z",
        },
      ] as never,
    });
    release();
    await flush();
    expect(h.deleteMessages).not.toHaveBeenCalled();
    expect(h.editor.commands.setContent).not.toHaveBeenCalled();
  });

  it.each([
    ["文字を打った", () => (h.editor.isEmpty = false)],
    ["editor が破棄された", () => (h.editor.isDestroyed = true)],
  ] as Array<[string, () => void]>)(
    "読取の間に%sら編集しない",
    async (_label, change) => {
      let release!: () => void;
      const invoke = vi.fn(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({ ok: true, value: { state: "unrestricted" } });
          }),
      );
      (window as unknown as { grimodex: unknown }).grimodex = {
        invoke,
        listen: vi.fn(() => () => undefined),
      };
      renderInput("project");
      h.onEditLast.current();
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      change();
      release();
      await flush();
      expect(h.deleteMessages).not.toHaveBeenCalled();
      expect(h.editor.commands.setContent).not.toHaveBeenCalled();
    },
  );

  it("場面の会話で route が capture の内なら状態を読まず、同期で編集する", () => {
    const invoke = installBridge({ state: "restricted" });
    renderInput("scene");
    h.onEditLast.current();
    expect(invoke).not.toHaveBeenCalled();
    expect(h.deleteMessages).toHaveBeenCalledWith(["u1", "a1"]);
    expect(h.editor.commands.setContent).toHaveBeenCalledWith("last question");
  });

  // 表の 5（DR-DA2B-R29）：場面の会話でも route が capture の外なら状態を読む。
  it.each([
    ["cloud の provider", () => configureCloudRoute()],
    ["agent", () => useChatStore.setState({ agentMode: true })],
  ] as Array<[string, () => void]>)(
    "場面の会話で %s なら restricted で行を消さない",
    async (_label, arrange) => {
      const invoke = installBridge({ state: "restricted" });
      renderInput("scene");
      arrange();
      h.onEditLast.current();
      await vi.waitFor(() =>
        expect(h.toastError).toHaveBeenCalledWith(i18next.t("common.error")),
      );
      await flush();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(h.deleteMessages).not.toHaveBeenCalled();
      expect(useChatStore.getState().messages).toHaveLength(2);
      expect(h.editor.commands.setContent).not.toHaveBeenCalled();
    },
  );

  it("場面の会話で cloud の route でも unrestricted なら今のとおり編集する", async () => {
    const invoke = installBridge({ state: "unrestricted" });
    configureCloudRoute();
    renderInput("scene");
    h.onEditLast.current();
    await vi.waitFor(() =>
      expect(h.editor.commands.setContent).toHaveBeenCalledWith(
        "last question",
      ),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(h.deleteMessages).toHaveBeenCalledWith(["u1", "a1"]);
  });

  // 独立レビューの P2-1（DR-DA2B-R32）：編集の前に選んでおいた slash command（本文から
  // 消えるが保留される）は、再送で `commandInstruction` になり capture の外になる。
  // click の時点の保留中の command を判定に含め、restricted では行を消さない。
  function selectBrainstorm() {
    act(() => {
      h.setCommandPopup.current?.({
        items: [{ id: "brainstorm", label: "brainstorm" }],
        selectedIndex: 0,
        clientRect: null,
        command: vi.fn(),
      });
    });
    act(() => {
      h.onCommandSelect.current?.({ id: "brainstorm", label: "brainstorm" });
    });
  }

  it("保留中の command があれば、loopback の場面の会話の ArrowUp も restricted で行を消さない", async () => {
    const invoke = installBridge({ state: "restricted" });
    renderInput("scene");
    selectBrainstorm();
    h.onEditLast.current();
    await vi.waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(i18next.t("common.error")),
    );
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(h.deleteMessages).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages).toHaveLength(2);
  });

  it("保留中の command があれば、loopback の場面の会話の menu の編集も restricted で行を消さない", async () => {
    const invoke = installBridge({ state: "restricted" });
    const editorRef = { current: null as unknown };
    renderInput("scene", editorRef);
    selectBrainstorm();
    const { result } = renderHook(() =>
      useChatMessageActions({
        aiSettings: null,
        chatEditorRef: editorRef as never,
        syncInsertedToEditorMetadata: vi.fn(),
      }),
    );
    result.current.handleEditMessage("u1");
    await vi.waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(i18next.t("common.error")),
    );
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(h.deleteMessages).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages).toHaveLength(2);
  });

  it("指示を作らない command（continue）は capture の内のまま同期で編集する", () => {
    const invoke = installBridge({ state: "restricted" });
    renderInput("scene");
    act(() => {
      h.setCommandPopup.current?.({
        items: [{ id: "continue", label: "continue" }],
        selectedIndex: 0,
        clientRect: null,
        command: vi.fn(),
      });
    });
    act(() => {
      h.onCommandSelect.current?.({ id: "continue", label: "continue" });
    });
    h.onEditLast.current();
    expect(invoke).not.toHaveBeenCalled();
    expect(h.deleteMessages).toHaveBeenCalledWith(["u1", "a1"]);
  });
});
