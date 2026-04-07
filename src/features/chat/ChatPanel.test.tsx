// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPanel } from "./ChatPanel";
import { useChatStore } from "./chatStore";
import { useEditorStore } from "@/features/editor/editorStore";

vi.mock("./chatApi", () => ({
  sendChatMessage: vi.fn(),
  listSessions: vi.fn(() => Promise.resolve([])),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  listMessages: vi.fn(() => Promise.resolve([])),
  addMessage: vi.fn(() => Promise.resolve({})),
  updateSessionTitle: vi.fn(() => Promise.resolve()),
  listPinnedCodexEntries: vi.fn(() => Promise.resolve([])),
  generateSessionTitle: vi.fn(() => Promise.resolve(null)),
  updateMessageMetadata: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/features/editor/editorStore", async () => {
  const { create } = await import("zustand");
  const store = create(() => ({
    editor: null,
    lastInsertRange: null,
    insertFromChat: vi.fn(() => true),
    insertFromSnippet: vi.fn(() => true),
    clearInsertRange: vi.fn(),
    setEditor: vi.fn(),
  }));
  return { useEditorStore: store };
});

vi.mock("@/features/codex/api", () => ({
  listCodexEntries: vi.fn(() => Promise.resolve([])),
  getCodexEntry: vi.fn(),
  createCodexEntry: vi.fn(),
  updateCodexEntry: vi.fn(),
  deleteCodexEntry: vi.fn(),
  listCodexEntriesByMessageId: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/features/snippets/api", () => ({
  listSnippets: vi.fn(() => Promise.resolve([])),
  getSnippet: vi.fn(),
  createSnippet: vi.fn(),
  updateSnippet: vi.fn(),
  deleteSnippet: vi.fn(),
  listSnippetsByMessageId: vi.fn(() => Promise.resolve([])),
}));

import * as chatApi from "./chatApi";
const mockSendChatMessage = vi.mocked(chatApi.sendChatMessage);

function resetStore() {
  useChatStore.setState({
    messages: [],
    sessions: [],
    isStreaming: false,
    error: null,
  });
}

describe("ChatPanel", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("renders the chat panel with input area", () => {
    render(<ChatPanel />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /送信/i })).toBeInTheDocument();
  });

  it("renders empty state when no messages", () => {
    render(<ChatPanel />);
    expect(screen.getByText(/メッセージ/i)).toBeInTheDocument();
  });

  it("displays user and assistant messages with distinct styles", () => {
    useChatStore.setState({
      messages: [
        {
          id: "1",
          sessionId: "",
          role: "user",
          content: "ユーザーの質問",
          createdAt: new Date().toISOString(),
        },
        {
          id: "2",
          sessionId: "",
          role: "assistant",
          content: "AIの回答",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<ChatPanel />);
    expect(screen.getByText("ユーザーの質問")).toBeInTheDocument();
    expect(screen.getByText("AIの回答")).toBeInTheDocument();

    const userMsg = screen.getByTestId("chat-message-1");
    const assistantMsg = screen.getByTestId("chat-message-2");
    expect(userMsg.dataset.role).toBe("user");
    expect(assistantMsg.dataset.role).toBe("assistant");
  });

  it("sends a message when submit button is clicked", async () => {
    const user = userEvent.setup();
    mockSendChatMessage.mockImplementation(async (_msgs, onChunk) => {
      onChunk("回答です");
    });

    render(<ChatPanel />);

    const input = screen.getByRole("textbox");
    await user.type(input, "質問です");
    await user.click(screen.getByRole("button", { name: /送信/i }));

    await waitFor(() => {
      expect(screen.getByText("質問です")).toBeInTheDocument();
    });
  });

  it("sends a message when Enter is pressed", async () => {
    const user = userEvent.setup();
    mockSendChatMessage.mockImplementation(async (_msgs, onChunk) => {
      onChunk("回答");
    });

    render(<ChatPanel />);

    const input = screen.getByRole("textbox");
    await user.type(input, "Enterで送信{Enter}");

    await waitFor(() => {
      expect(screen.getByText("Enterで送信")).toBeInTheDocument();
    });
  });

  it("does not send on Shift+Enter (allows newline)", async () => {
    const user = userEvent.setup();

    render(<ChatPanel />);

    const input = screen.getByRole("textbox");
    await user.type(input, "1行目{Shift>}{Enter}{/Shift}2行目");

    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it("clears input after sending", async () => {
    const user = userEvent.setup();
    mockSendChatMessage.mockImplementation(async () => {});

    render(<ChatPanel />);

    const input = screen.getByRole("textbox");
    await user.type(input, "送信テスト{Enter}");

    await waitFor(() => {
      expect(input).toHaveValue("");
    });
  });

  it("disables send button while streaming", () => {
    useChatStore.setState({ isStreaming: true });

    render(<ChatPanel />);

    expect(screen.getByRole("button", { name: /送信/i })).toBeDisabled();
  });

  it("disables send button when input is empty", () => {
    render(<ChatPanel />);
    expect(screen.getByRole("button", { name: /送信/i })).toBeDisabled();
  });

  it("displays error message when error occurs", () => {
    useChatStore.setState({ error: "接続エラー" });

    render(<ChatPanel />);

    expect(screen.getByText("接続エラー")).toBeInTheDocument();
  });

  it("renders assistant messages as markdown", () => {
    useChatStore.setState({
      messages: [
        {
          id: "1",
          sessionId: "",
          role: "assistant",
          content: "**太字テスト**",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<ChatPanel />);

    const strong = screen.getByText("太字テスト");
    expect(strong.tagName).toBe("STRONG");
  });

  it("shows streaming indicator during response generation", () => {
    useChatStore.setState({
      isStreaming: true,
      messages: [
        {
          id: "1",
          sessionId: "",
          role: "user",
          content: "質問",
          createdAt: new Date().toISOString(),
        },
        {
          id: "2",
          sessionId: "",
          role: "assistant",
          content: "生成中...",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<ChatPanel />);

    expect(screen.getByTestId("streaming-indicator")).toBeInTheDocument();
  });

  // --- Insert button tests (via actions menu) ---

  it("shows actions menu on assistant messages", () => {
    useChatStore.setState({
      messages: [
        {
          id: "a1",
          sessionId: "",
          role: "assistant",
          content: "挿入可能なテキスト",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<ChatPanel />);

    const actionsBtn = screen.getByTestId("message-actions-a1");
    expect(actionsBtn).toBeInTheDocument();
  });

  it("shows insert option in actions menu for assistant messages", async () => {
    const user = userEvent.setup();
    useChatStore.setState({
      messages: [
        {
          id: "a1",
          sessionId: "",
          role: "assistant",
          content: "挿入可能なテキスト",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<ChatPanel />);

    await user.click(screen.getByTestId("message-actions-a1"));
    const insertBtn = screen.getByTestId("insert-to-editor-a1");
    expect(insertBtn).toBeInTheDocument();
  });

  it("does NOT show actions menu on user messages while streaming", () => {
    useChatStore.setState({
      isStreaming: true,
      messages: [
        {
          id: "u1",
          sessionId: "",
          role: "user",
          content: "ユーザーメッセージ",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<ChatPanel />);

    expect(screen.queryByTestId("message-actions-u1")).not.toBeInTheDocument();
  });

  it("does NOT show actions menu on assistant messages while streaming", () => {
    useChatStore.setState({
      isStreaming: true,
      messages: [
        {
          id: "a1",
          sessionId: "",
          role: "assistant",
          content: "生成中テキスト",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<ChatPanel />);

    expect(screen.queryByTestId("message-actions-a1")).not.toBeInTheDocument();
  });

  it("calls insertFromChat when insert option is clicked", async () => {
    const user = userEvent.setup();
    const mockInsert = vi.mocked(useEditorStore.getState().insertFromChat);

    useChatStore.setState({
      messages: [
        {
          id: "a1",
          sessionId: "",
          role: "assistant",
          content: "挿入するテキスト",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<ChatPanel />);

    await user.click(screen.getByTestId("message-actions-a1"));
    await user.click(screen.getByTestId("insert-to-editor-a1"));

    expect(mockInsert).toHaveBeenCalledWith(
      "挿入するテキスト",
      "a1",
      undefined,
    );
  });

  it("does NOT show actions menu when assistant message is empty", () => {
    useChatStore.setState({
      messages: [
        {
          id: "a1",
          sessionId: "",
          role: "assistant",
          content: "",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<ChatPanel />);

    expect(screen.queryByTestId("message-actions-a1")).not.toBeInTheDocument();
  });

  it("shows actions menu on user messages (for codex/snippet extraction)", () => {
    useChatStore.setState({
      messages: [
        {
          id: "u1",
          sessionId: "",
          role: "user",
          content: "ユーザーメッセージ",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<ChatPanel />);

    expect(screen.getByTestId("message-actions-u1")).toBeInTheDocument();
  });
});
