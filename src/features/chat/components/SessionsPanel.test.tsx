// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionsPanel } from "./SessionsPanel";
import type { ChatSession } from "@/features/chat/chatTypes";

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

const mockLoadSessions = vi.fn(() => Promise.resolve());
const mockCreateNewSession = vi.fn(() => Promise.resolve());
const mockDeleteSession = vi.fn(() => Promise.resolve());
const mockSelectSession = vi.fn(() => Promise.resolve());

// snippet スコープ滞在中の状態を固定したセレクタ式スタブ
vi.mock("@/features/chat/chatStore", () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      sessions: [session],
      isLoadingSessions: false,
      activeSessionId: null,
      loadSessions: mockLoadSessions,
      selectSession: mockSelectSession,
      createNewSession: mockCreateNewSession,
      deleteSession: mockDeleteSession,
      chatScope: "snippet",
      scopeAnchorId: "snip-1",
    }),
}));

describe("SessionsPanel — snippet スコープのセッションキー伝播", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderPanel() {
    return render(
      <SessionsPanel sceneTitle="" activeSceneId="" onClose={vi.fn()} />,
    );
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
});
