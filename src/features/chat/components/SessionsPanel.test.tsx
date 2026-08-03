// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { SessionsPanel } from "./SessionsPanel";
import type { ChatSession } from "@/features/chat/chatTypes";
import type { ChatScope } from "@/features/chat/chatScope";
import * as chatApi from "@/features/chat/chatApi";
import {
  _resetQuiescenceParticipantsForTests,
  flushQuiescenceParticipants,
} from "@/application/lifecycle/quiescenceParticipants";
import { setCurrentImeWorkspaceIdentity } from "@/features/ime/workspaceScope";
import { toast } from "sonner";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "proj-1",
}));

vi.mock("@/features/chat/chatApi", () => ({
  updateSessionTitle: vi.fn(() => Promise.resolve()),
}));

const session: ChatSession = {
  id: "session-1",
  projectId: "proj-1",
  nodeId: null,
  codexAnchorId: null,
  snippetAnchorId: "snip-1",
  title: "Snippet 会話",
  titleManual: 0,
  model: "openrouter/anthropic/claude-sonnet-4.6",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
let mockSessions: ChatSession[] = [{ ...session }];
let mockChatScope: ChatScope = "snippet";
let mockScopeAnchorId: string | null = "snip-1";
let mockActiveSceneId = "";
let mockActiveProjectId: string | null = "proj-1";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mockLoadSessions = vi.fn(() => Promise.resolve(true));
const mockCreateNewSession = vi.fn(() => Promise.resolve());
const mockDeleteSession = vi.fn(() => Promise.resolve());
const mockSelectSession = vi.fn(() => Promise.resolve());

function readMockChatState() {
  return {
    sessions: mockSessions,
    isLoadingSessions: false,
    activeSessionId: null,
    activeSceneId: mockActiveSceneId,
    activeProjectId: mockActiveProjectId,
    loadSessions: mockLoadSessions,
    selectSession: mockSelectSession,
    createNewSession: mockCreateNewSession,
    deleteSession: mockDeleteSession,
    chatScope: mockChatScope,
    scopeAnchorId: mockScopeAnchorId,
  };
}

// snippet スコープ滞在中の状態を固定したセレクタ式スタブ
vi.mock("@/features/chat/chatStore", () => {
  const useChatStore = Object.assign(
    (sel: (state: ReturnType<typeof readMockChatState>) => unknown) =>
      sel(readMockChatState()),
    { getState: readMockChatState },
  );
  return { useChatStore };
});

describe("SessionsPanel — snippet スコープのセッションキー伝播", () => {
  beforeEach(() => {
    _resetQuiescenceParticipantsForTests();
    vi.clearAllMocks();
    mockSessions = [{ ...session }];
    mockChatScope = "snippet";
    mockScopeAnchorId = "snip-1";
    mockActiveSceneId = "";
    mockActiveProjectId = "proj-1";
    vi.mocked(chatApi.updateSessionTitle).mockResolvedValue(undefined);
    mockLoadSessions.mockResolvedValue(true);
    mockCreateNewSession.mockResolvedValue(undefined);
    mockDeleteSession.mockResolvedValue(undefined);
    mockSelectSession.mockResolvedValue(undefined);
    setCurrentImeWorkspaceIdentity({
      path: "/workspace/sessions-panel-a",
      openRevision: 1,
    });
  });

  afterEach(() => {
    _resetQuiescenceParticipantsForTests();
    setCurrentImeWorkspaceIdentity(null);
  });

  function renderPanel(onClose = vi.fn()) {
    return render(
      <SessionsPanel sceneTitle="" activeSceneId="" onClose={onClose} />,
    );
  }

  async function switchToSnippetScope(
    view: ReturnType<typeof renderPanel>,
    snippetId: string,
  ): Promise<void> {
    mockChatScope = "snippet";
    mockScopeAnchorId = snippetId;
    mockSessions = [
      {
        ...session,
        id: `session-${snippetId}`,
        snippetAnchorId: snippetId,
        title: `Session ${snippetId}`,
      },
    ];
    view.rerender(
      <SessionsPanel sceneTitle="" activeSceneId="" onClose={vi.fn()} />,
    );
    await waitFor(() => {
      expect(mockLoadSessions).toHaveBeenCalledWith(
        undefined,
        undefined,
        snippetId,
      );
    });
  }

  it("disables create, rename, and delete while session mutations are blocked", () => {
    render(
      <SessionsPanel
        sceneTitle=""
        activeSceneId=""
        onClose={vi.fn()}
        mutationsDisabled
      />,
    );

    expect(screen.getByText("New session")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "chat.sessionMenu" }));
    expect(screen.getByText("chat.sessionRename")).toBeDisabled();
    expect(screen.getByText("common.delete")).toBeDisabled();
  });

  it("初回ロードが snippetAnchorId でフィルタする", () => {
    renderPanel();
    expect(mockLoadSessions).toHaveBeenCalledWith(
      undefined,
      undefined,
      "snip-1",
    );
  });

  it("新規作成が snippetAnchorId 付きでセッションを作り、同キーで再ロードする", async () => {
    renderPanel();
    mockLoadSessions.mockClear();

    fireEvent.click(screen.getByText("New session"));

    await waitFor(() => {
      expect(mockCreateNewSession).toHaveBeenCalledWith(
        "proj-1",
        "New session",
        undefined,
        undefined,
        "snip-1",
      );
    });
    expect(mockLoadSessions).toHaveBeenCalledWith(
      undefined,
      undefined,
      "snip-1",
    );
  });

  it("削除後の再ロードが snippetAnchorId でフィルタする", async () => {
    // happy-dom は confirm 未実装なので直接 stub する
    window.confirm = vi.fn(() => true);
    renderPanel();
    mockLoadSessions.mockClear();

    // SessionItem のメニューを開いて削除
    fireEvent.click(screen.getByRole("button", { name: "chat.sessionMenu" }));
    fireEvent.click(screen.getByText("common.delete"));

    await waitFor(() => {
      expect(mockDeleteSession).toHaveBeenCalledWith("session-1");
    });
    expect(mockLoadSessions).toHaveBeenCalledWith(
      undefined,
      undefined,
      "snip-1",
    );
  });

  it("strict quiescence は未blurのセッション名を保存する", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "chat.sessionMenu" }));
    fireEvent.click(screen.getByText("chat.sessionRename"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "境界前の会話名" } });

    await flushQuiescenceParticipants();

    expect(chatApi.updateSessionTitle).toHaveBeenCalledWith(
      "session-1",
      "境界前の会話名",
    );
  });

  it("rename成功後に再取得したsession.titleへ編集値を同期する", async () => {
    const view = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "chat.sessionMenu" }));
    fireEvent.click(screen.getByText("chat.sessionRename"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "ローカル変更名" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    await waitFor(() => {
      expect(chatApi.updateSessionTitle).toHaveBeenCalledWith(
        "session-1",
        "ローカル変更名",
      );
      expect(screen.queryByRole("textbox")).toBeNull();
    });

    mockSessions = [{ ...session, title: "再取得後の正規タイトル" }];
    view.rerender(
      <SessionsPanel sceneTitle="" activeSceneId="" onClose={vi.fn()} />,
    );
    expect(screen.getByText("再取得後の正規タイトル")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "chat.sessionMenu" }));
    fireEvent.click(screen.getByText("chat.sessionRename"));
    expect(screen.getByRole("textbox")).toHaveValue("再取得後の正規タイトル");
  });

  it("rename保存中の追加入力を再保存し、最新値の成功まで編集を閉じない", async () => {
    const first = deferred();
    const latest = deferred();
    vi.mocked(chatApi.updateSessionTitle)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => latest.promise);

    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "chat.sessionMenu" }));
    fireEvent.click(screen.getByText("chat.sessionRename"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "最初の名前" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(chatApi.updateSessionTitle).toHaveBeenNthCalledWith(
        1,
        "session-1",
        "最初の名前",
      );
    });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "最新の名前" },
    });

    first.resolve();
    await waitFor(() => {
      expect(chatApi.updateSessionTitle).toHaveBeenNthCalledWith(
        2,
        "session-1",
        "最新の名前",
      );
    });
    expect(screen.getByRole("textbox")).toHaveValue("最新の名前");

    latest.resolve();
    await waitFor(() => {
      expect(screen.queryByRole("textbox")).toBeNull();
    });
  });

  it("scope A rename 完了後に scope B を旧キーで再ロードしない", async () => {
    const rename = deferred();
    vi.mocked(chatApi.updateSessionTitle).mockReturnValueOnce(rename.promise);
    const view = renderPanel();
    mockLoadSessions.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "chat.sessionMenu" }));
    fireEvent.click(screen.getByText("chat.sessionRename"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Scope A rename" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() =>
      expect(chatApi.updateSessionTitle).toHaveBeenCalledOnce(),
    );

    await switchToSnippetScope(view, "snip-2");
    mockLoadSessions.mockClear();
    await act(async () => {
      rename.resolve();
      await rename.promise;
      await Promise.resolve();
    });

    expect(mockLoadSessions).not.toHaveBeenCalled();
  });

  it("scope A delete 完了後に scope B を旧キーで再ロードしない", async () => {
    const deletion = deferred();
    mockDeleteSession.mockReturnValueOnce(deletion.promise);
    window.confirm = vi.fn(() => true);
    const view = renderPanel();
    mockLoadSessions.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "chat.sessionMenu" }));
    fireEvent.click(screen.getByText("common.delete"));
    await waitFor(() => expect(mockDeleteSession).toHaveBeenCalledOnce());

    await switchToSnippetScope(view, "snip-2");
    mockLoadSessions.mockClear();
    await act(async () => {
      deletion.resolve();
      await deletion.promise;
      await Promise.resolve();
    });

    expect(mockLoadSessions).not.toHaveBeenCalled();
  });

  it("scope A create 完了後に scope B を旧キーで再ロード・closeしない", async () => {
    const creation = deferred();
    const onClose = vi.fn();
    mockCreateNewSession.mockReturnValueOnce(creation.promise);
    const view = renderPanel(onClose);
    mockLoadSessions.mockClear();
    fireEvent.click(screen.getByText("New session"));
    await waitFor(() => expect(mockCreateNewSession).toHaveBeenCalledOnce());

    mockChatScope = "snippet";
    mockScopeAnchorId = "snip-2";
    mockSessions = [
      {
        ...session,
        id: "session-snip-2",
        snippetAnchorId: "snip-2",
      },
    ];
    view.rerender(
      <SessionsPanel sceneTitle="" activeSceneId="" onClose={onClose} />,
    );
    await waitFor(() =>
      expect(mockLoadSessions).toHaveBeenCalledWith(
        undefined,
        undefined,
        "snip-2",
      ),
    );
    mockLoadSessions.mockClear();
    await act(async () => {
      creation.resolve();
      await creation.promise;
      await Promise.resolve();
    });

    expect(mockLoadSessions).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Workspace A create 完了後に同じ project/scope ID の Workspace B を再ロード・closeしない", async () => {
    const creation = deferred();
    const onClose = vi.fn();
    mockCreateNewSession.mockReturnValueOnce(creation.promise);
    const view = renderPanel(onClose);
    mockLoadSessions.mockClear();
    fireEvent.click(screen.getByText("New session"));
    await waitFor(() => expect(mockCreateNewSession).toHaveBeenCalledOnce());

    setCurrentImeWorkspaceIdentity({
      path: "/workspace/sessions-panel-b",
      openRevision: 2,
    });
    view.rerender(
      <SessionsPanel sceneTitle="" activeSceneId="" onClose={onClose} />,
    );
    mockLoadSessions.mockClear();
    await act(async () => {
      creation.resolve();
      await creation.promise;
      await Promise.resolve();
    });

    expect(mockLoadSessions).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Workspace A rename 完了後に同じ IDs の Workspace B を再ロードしない", async () => {
    const rename = deferred();
    vi.mocked(chatApi.updateSessionTitle).mockReturnValueOnce(rename.promise);
    renderPanel();
    mockLoadSessions.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "chat.sessionMenu" }));
    fireEvent.click(screen.getByText("chat.sessionRename"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Workspace A rename" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() =>
      expect(chatApi.updateSessionTitle).toHaveBeenCalledOnce(),
    );

    setCurrentImeWorkspaceIdentity({
      path: "/workspace/sessions-panel-b",
      openRevision: 2,
    });
    await act(async () => {
      rename.resolve();
      await rename.promise;
      await Promise.resolve();
    });

    expect(mockLoadSessions).not.toHaveBeenCalled();
  });

  it("Workspace A rename の失敗を同じ IDs の Workspace B に通知しない", async () => {
    const rename = deferred();
    vi.mocked(chatApi.updateSessionTitle).mockReturnValueOnce(rename.promise);
    renderPanel();
    mockLoadSessions.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "chat.sessionMenu" }));
    fireEvent.click(screen.getByText("chat.sessionRename"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Workspace A rename" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() =>
      expect(chatApi.updateSessionTitle).toHaveBeenCalledOnce(),
    );

    setCurrentImeWorkspaceIdentity({
      path: "/workspace/sessions-panel-a",
      openRevision: 2,
    });
    await act(async () => {
      rename.reject(new Error("workspace A rename failed"));
      await rename.promise.catch(() => {});
      await Promise.resolve();
    });

    expect(mockLoadSessions).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("Workspace A delete 完了後に同じ IDs の Workspace B を再ロードしない", async () => {
    const deletion = deferred();
    mockDeleteSession.mockReturnValueOnce(deletion.promise);
    window.confirm = vi.fn(() => true);
    renderPanel();
    mockLoadSessions.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "chat.sessionMenu" }));
    fireEvent.click(screen.getByText("common.delete"));
    await waitFor(() => expect(mockDeleteSession).toHaveBeenCalledOnce());

    setCurrentImeWorkspaceIdentity({
      path: "/workspace/sessions-panel-b",
      openRevision: 2,
    });
    await act(async () => {
      deletion.resolve();
      await deletion.promise;
      await Promise.resolve();
    });

    expect(mockLoadSessions).not.toHaveBeenCalled();
  });

  it("Workspace A create/delete の失敗を同じ IDs の Workspace B に通知・closeしない", async () => {
    const creation = deferred();
    const deletion = deferred();
    const onClose = vi.fn();
    mockCreateNewSession.mockReturnValueOnce(creation.promise);
    const view = renderPanel(onClose);
    mockLoadSessions.mockClear();

    fireEvent.click(screen.getByText("New session"));
    await waitFor(() => expect(mockCreateNewSession).toHaveBeenCalledOnce());
    setCurrentImeWorkspaceIdentity({
      path: "/workspace/sessions-panel-a",
      openRevision: 2,
    });
    await act(async () => {
      creation.reject(new Error("workspace A create failed"));
      await creation.promise.catch(() => {});
      await Promise.resolve();
    });

    expect(toast.error).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(mockLoadSessions).not.toHaveBeenCalled();

    setCurrentImeWorkspaceIdentity({
      path: "/workspace/sessions-panel-a",
      openRevision: 3,
    });
    view.rerender(
      <SessionsPanel sceneTitle="" activeSceneId="" onClose={onClose} />,
    );
    mockLoadSessions.mockClear();
    mockDeleteSession.mockReturnValueOnce(deletion.promise);
    window.confirm = vi.fn(() => true);
    fireEvent.click(screen.getByRole("button", { name: "chat.sessionMenu" }));
    fireEvent.click(screen.getByText("common.delete"));
    await act(async () => {
      setCurrentImeWorkspaceIdentity({
        path: "/workspace/sessions-panel-a",
        openRevision: 4,
      });
      deletion.reject(new Error("workspace A delete failed"));
      await deletion.promise.catch(() => {});
      await Promise.resolve();
    });

    expect(toast.error).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(mockLoadSessions).not.toHaveBeenCalled();
  });

  it("IME composition Enter/Escape ではセッション名を確定・取消ししない", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "chat.sessionMenu" }));
    fireEvent.click(screen.getByText("chat.sessionRename"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "変換中の会話名" } });

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });

    expect(chatApi.updateSessionTitle).not.toHaveBeenCalled();
    expect(input.value).toBe("変換中の会話名");
    fireEvent.keyDown(input, { key: "Escape" });
  });
});
