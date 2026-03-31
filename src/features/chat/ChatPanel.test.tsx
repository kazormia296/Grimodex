import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPanel } from "./ChatPanel";
import { useChatStore } from "./chatStore";

vi.mock("./chatApi", () => ({
  sendChatMessage: vi.fn(),
  listThreads: vi.fn(),
  createThread: vi.fn(),
  deleteThread: vi.fn(),
  listMessages: vi.fn(),
  addMessage: vi.fn(),
  updateThreadTitle: vi.fn(),
}));

import * as chatApi from "./chatApi";
const mockSendChatMessage = vi.mocked(chatApi.sendChatMessage);

function resetStore() {
  useChatStore.setState({
    messages: [],
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
          threadId: "",
          role: "user",
          content: "ユーザーの質問",
          createdAt: new Date().toISOString(),
        },
        {
          id: "2",
          threadId: "",
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
          threadId: "",
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
          threadId: "",
          role: "user",
          content: "質問",
          createdAt: new Date().toISOString(),
        },
        {
          id: "2",
          threadId: "",
          role: "assistant",
          content: "生成中...",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<ChatPanel />);

    expect(screen.getByTestId("streaming-indicator")).toBeInTheDocument();
  });
});
