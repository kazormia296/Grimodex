// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ChatPanel,
  declineCodexApprovals,
  enqueueCodexApproval,
  removeCodexApproval,
  removeCodexApprovalsForTurn,
  saveChatScopeBeforeSend,
  selectSceneFromChat,
  type CodexApproval,
} from "./ChatPanel";
import { useChatStore } from "./chatStore";
import { useAiSettingsStore } from "./store";
import { DEFAULT_AI_SETTINGS } from "./types";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useProjectStore } from "@/features/project/projectStore";
import {
  registerSaveHandler,
  unregisterSaveHandler,
} from "@/features/editor/editorSaveRegistry";

// ChatInput を軽量なtextareaモックで置換（TipTapはhappy-domで動作不安定なため）
vi.mock("./components/ChatInput", async () => {
  const { useState } = await import("react");
  return {
    ChatInput: vi.fn(
      ({
        onSend,
        disabled,
      }: {
        onSend: (markdown: string) => Promise<boolean>;
        disabled?: boolean;
      }) => {
        const [val, setVal] = useState("");
        const isStreaming = disabled ?? false;
        return (
          <div>
            <textarea
              role="textbox"
              value={val}
              disabled={isStreaming}
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (val.trim() && !isStreaming) {
                    const accepted = await onSend(val);
                    if (accepted) setVal("");
                  }
                }
              }}
            />
            {isStreaming ? (
              <button type="button" aria-label="生成中断" onClick={() => {}}>
                ■
              </button>
            ) : (
              <button
                type="button"
                aria-label="送信"
                disabled={!val.trim()}
                onClick={async () => {
                  if (val.trim()) {
                    const accepted = await onSend(val);
                    if (accepted) setVal("");
                  }
                }}
              >
                →
              </button>
            )}
          </div>
        );
      },
    ),
  };
});

vi.mock("./chatApi", () => {
  const sendChatMessage = vi.fn();
  const session = (
    id: string,
    projectId: string,
    title = "New session",
    nodeId?: string,
  ) => ({
    id,
    projectId,
    title,
    titleManual: 0,
    model: "",
    nodeId: nodeId ?? null,
    codexAnchorId: null,
    snippetAnchorId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  return {
    sendChatMessage,
    sendChatMessageStream: vi.fn(
      async (
        messages: Array<{ role: string; content: string }>,
        _thinkingParams: unknown,
        callbacks: {
          onTextDelta: (delta: string) => void;
          onDone: (info: { stopReason: string }) => void;
        },
      ) => {
        await sendChatMessage(messages, callbacks.onTextDelta);
        callbacks.onDone({ stopReason: "end_turn" });
        return () => {};
      },
    ),
    abortChatStream: vi.fn(() => Promise.resolve()),
    listSessions: vi.fn(() => Promise.resolve([])),
    getSessionForProject: vi.fn((sessionId: string, projectId: string) =>
      Promise.resolve(session(sessionId, projectId)),
    ),
    createSession: vi.fn((projectId: string, title: string, nodeId?: string) =>
      Promise.resolve(session("session-created", projectId, title, nodeId)),
    ),
    deleteSession: vi.fn(),
    listMessages: vi.fn(() => Promise.resolve([])),
    listSummaries: vi.fn(() => Promise.resolve([])),
    getSummaryGeneration: vi.fn(() => Promise.resolve(1)),
    addMessage: vi.fn(() => Promise.resolve({})),
    saveMessagePrompt: vi.fn(() => Promise.resolve()),
    updateSessionTitle: vi.fn(() => Promise.resolve()),
    listPinnedCodexEntries: vi.fn(() => Promise.resolve([])),
    listPinnedSnippetEntries: vi.fn(() => Promise.resolve([])),
    listPinnedStickyEntries: vi.fn(() => Promise.resolve([])),
    generateSessionTitle: vi.fn(() => Promise.resolve(null)),
    updateMessageMetadata: vi.fn(() => Promise.resolve()),
  };
});

// tiktoken WASM の dynamic import がフルテスト並列実行時に遅くなり
// `await ensureTokenizer()` が waitFor timeout に間に合わない問題のガード。
vi.mock("./contextBuilder", async () => {
  const actual =
    await vi.importActual<typeof import("./contextBuilder")>(
      "./contextBuilder",
    );
  return {
    ...actual,
    ensureTokenizer: vi.fn(() => Promise.resolve()),
  };
});

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
    getCodexEntry: vi.fn(),
    createCodexEntry: vi.fn(),
    updateCodexEntry: vi.fn(),
    deleteCodexEntry: vi.fn(),
    listCodexEntriesByMessageId: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock("@/features/snippets/api", () => ({
  listSnippets: vi.fn(() => Promise.resolve([])),
  getSnippet: vi.fn(),
  createSnippet: vi.fn(),
  updateSnippet: vi.fn(),
  deleteSnippet: vi.fn(),
  listSnippetsByMessageId: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/features/project/api", () => ({
  getProject: vi.fn((projectId: string) =>
    Promise.resolve({
      id: projectId,
      title: "テストプロジェクト",
      genre: "ファンタジー",
      language: "ja",
    }),
  ),
}));

import * as chatApi from "./chatApi";
const mockSendChatMessage = vi.mocked(chatApi.sendChatMessage);

function resetStore() {
  useChatStore.setState({
    messages: [],
    streamingDraft: null,
    sessions: [],
    isStreaming: false,
    isLoadingSessions: false,
    isLoadingMessages: false,
    error: null,
    chatScope: "scene",
    scopeAnchorId: null,
    activeProjectId: "proj-1",
    activeSceneId: "",
    activeSessionId: null,
    inputPinnedEntryIds: [],
  });
  useTreeStore.setState({ projectId: "proj-1", activeSceneId: "" });
  useProjectStore.setState({ currentProjectId: "proj-1", projects: [] });
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

  it.each([
    ["セッション読込中", { isLoadingSessions: true }],
    ["メッセージ読込中", { isLoadingMessages: true }],
    ["生成中", { isStreaming: true }],
  ])("%s は Spotlight trigger を無効化する", (_label, state) => {
    useChatStore.setState(state);

    render(<ChatPanel />);

    expect(
      screen.getByRole("button", {
        name: "Codex/Snippet を Spotlight",
      }),
    ).toBeDisabled();
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

  it("flushes every Codex phase or the exact Snippet before a scoped send", async () => {
    const codexSave = vi.fn(async () => {});
    const codexPhaseSave = vi.fn(async () => {});
    const snippetSave = vi.fn(async () => {});
    const codexKey = { kind: "codex", id: "codex-1", phaseId: null } as const;
    const codexPhaseKey = {
      kind: "codex",
      id: "codex-1",
      phaseId: "phase-1",
    } as const;
    const snippetKey = { kind: "snippet", id: "snippet-1" } as const;
    registerSaveHandler(codexKey, codexSave);
    registerSaveHandler(codexPhaseKey, codexPhaseSave);
    registerSaveHandler(snippetKey, snippetSave);

    try {
      await saveChatScopeBeforeSend("codex", null, "codex-1");
      expect(codexSave).toHaveBeenCalledOnce();
      expect(codexPhaseSave).toHaveBeenCalledOnce();
      expect(snippetSave).not.toHaveBeenCalled();

      await saveChatScopeBeforeSend("snippet", null, "snippet-1");
      expect(snippetSave).toHaveBeenCalledOnce();
    } finally {
      unregisterSaveHandler(codexKey, codexSave);
      unregisterSaveHandler(codexPhaseKey, codexPhaseSave);
      unregisterSaveHandler(snippetKey, snippetSave);
    }
  });

  it("flushes mounted tree documents for folder and project sends", async () => {
    const treeSave = vi.fn(async () => {});
    const codexSave = vi.fn(async () => {});
    const treeKey = {
      kind: "tree",
      id: "scene-child",
      storage: "database",
    } as const;
    const codexKey = {
      kind: "codex",
      id: "scene-child",
      phaseId: null,
    } as const;
    registerSaveHandler(treeKey, treeSave);
    registerSaveHandler(codexKey, codexSave);

    try {
      await saveChatScopeBeforeSend("folder", null, "folder-1");
      await saveChatScopeBeforeSend("project", null, null);
      expect(treeSave).toHaveBeenCalledTimes(2);
      expect(codexSave).not.toHaveBeenCalled();
    } finally {
      unregisterSaveHandler(treeKey, treeSave);
      unregisterSaveHandler(codexKey, codexSave);
    }
  });

  it("propagates a scoped save failure so chat sending can stop", async () => {
    const failure = new Error("disk full");
    const save = vi.fn(async () => {
      throw failure;
    });
    const key = { kind: "codex", id: "codex-failed", phaseId: null } as const;
    registerSaveHandler(key, save);

    try {
      await expect(
        saveChatScopeBeforeSend("codex", null, "codex-failed"),
      ).rejects.toBe(failure);
      expect(save).toHaveBeenCalledOnce();
    } finally {
      unregisterSaveHandler(key, save);
    }
  });

  it("keeps the composer draft when a scoped save fails", async () => {
    const user = userEvent.setup();
    const failure = new Error("disk full");
    const key = {
      kind: "codex",
      id: "codex-failed-ui",
      phaseId: null,
    } as const;
    registerSaveHandler(
      key,
      vi.fn(async () => Promise.reject(failure)),
    );
    useChatStore.setState({
      chatScope: "codex",
      scopeAnchorId: "codex-failed-ui",
    });

    try {
      render(<ChatPanel />);
      const input = screen.getByRole("textbox");
      await waitFor(() => expect(input).toBeEnabled());
      await user.type(input, "失われない下書き{Enter}");

      await waitFor(() => {
        expect(input).toHaveValue("失われない下書き");
      });
      expect(useChatStore.getState().messages).toEqual([]);
    } finally {
      unregisterSaveHandler(key);
    }
  });

  it("keeps the draft and aborts when scope authority changes during save", async () => {
    const user = userEvent.setup();
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const save = vi.fn(() => saveGate);
    const key = {
      kind: "codex",
      id: "codex-authority",
      phaseId: null,
    } as const;
    registerSaveHandler(key, save);
    useChatStore.setState({
      chatScope: "codex",
      scopeAnchorId: "codex-authority",
    });

    try {
      render(<ChatPanel />);
      const input = screen.getByRole("textbox");
      await waitFor(() => expect(input).toBeEnabled());
      await user.type(input, "旧スコープの下書き{Enter}");
      await waitFor(() => expect(save).toHaveBeenCalledOnce());

      act(() => {
        useChatStore.getState().setChatScope("project");
        releaseSave();
      });

      await waitFor(() => {
        expect(input).toHaveValue("旧スコープの下書き");
      });
      expect(useChatStore.getState().messages).toEqual([]);
    } finally {
      unregisterSaveHandler(key, save);
    }
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

  it("shows stop button while streaming", () => {
    useChatStore.setState({ isStreaming: true });

    render(<ChatPanel />);

    // ストリーミング中は Send→Stop ボタンに切り替わる
    expect(
      screen.getByRole("button", { name: /生成中断/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /送信/i }),
    ).not.toBeInTheDocument();
  });

  it("queues approval requests and clears only the answered request", () => {
    const approval = (
      requestId: string,
      title: string,
      grimodexTurnId = "turn-1",
    ): CodexApproval => {
      const request: CodexApproval["request"] = {
        type: "approval-requested",
        requestId,
        kind: "command",
        title,
        summary: title,
      };
      return {
        envelope: {
          projectId: "proj-1",
          sessionId: "session-1",
          grimodexTurnId,
          event: request,
        },
        request,
      };
    };
    const first = approval("request-1", "First approval");
    const second = approval("request-2", "Second approval");
    const otherTurn = approval("request-3", "Other turn", "turn-2");

    let queue = enqueueCodexApproval([], first);
    queue = enqueueCodexApproval(queue, second);

    expect(enqueueCodexApproval(queue, first)).toBe(queue);
    expect(removeCodexApproval(queue, first)).toEqual([second]);
    expect(
      removeCodexApprovalsForTurn([...queue, otherTurn], "turn-1"),
    ).toEqual([otherTurn]);
  });

  it("best-effort declines every pending approval when releasing a session", async () => {
    const request = (requestId: string, sessionId: string): CodexApproval => {
      const approvalRequest: CodexApproval["request"] = {
        type: "approval-requested",
        requestId,
        kind: "permission",
        title: requestId,
        summary: requestId,
      };
      return {
        envelope: {
          projectId: "proj-1",
          sessionId,
          grimodexTurnId: `turn-${requestId}`,
          event: approvalRequest,
        },
        request: approvalRequest,
      };
    };
    const respond = vi
      .fn()
      .mockRejectedValueOnce(new Error("request already settled"))
      .mockResolvedValueOnce(undefined);

    await expect(
      declineCodexApprovals(
        [request("request-1", "session-1"), request("request-2", "session-1")],
        respond,
      ),
    ).resolves.toBeUndefined();
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: "session-1",
        requestId: "request-1",
        decision: "decline",
      }),
    );
    expect(respond).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: "session-1",
        requestId: "request-2",
        decision: "decline",
      }),
    );
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

  // 擬似ツール記法 (<tool_call>/<tool_response>) が Codex エントリ（=ナレッジ
  // ベース）に焼き込まれないこと。全文抽出は wholeMessageContent 経由で浄化する。
  it("strips pseudo tool-call markup before baking into a Codex entry (quick extract)", async () => {
    const user = userEvent.setup();
    const createSpy = vi.fn((_data: { name: string; summary: string }) =>
      Promise.resolve({ id: "c1" }),
    );
    useCodexStore.setState({
      create: createSpy as unknown as ReturnType<
        typeof useCodexStore.getState
      >["create"],
    });

    useChatStore.setState({
      messages: [
        {
          id: "a1",
          sessionId: "",
          role: "assistant",
          content:
            "前置きの文章\n" +
            '<tool_call>{"name":"web_search","arguments":{"query":"x"}}</tool_call>\n' +
            '<tool_response>{"success":true}</tool_response>\n' +
            "本当の回答本文",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<ChatPanel />);

    await user.click(screen.getByTestId("extract-codex-quick-a1"));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    const arg = createSpy.mock.calls[0][0];
    expect(arg.summary).not.toContain("<tool_call>");
    expect(arg.summary).not.toContain("<tool_response>");
    expect(arg.summary).not.toContain("web_search");
    expect(arg.summary).toContain("本当の回答本文");
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

  // --- 仮想化されたメッセージリスト ---
  // happy-dom では virtualizer は全件レンダの mock (test-setup.ts) なので、
  // ここでは「仮想化の配線」(コンテナ高さ・data-index 行・filter) と
  // 「入場アニメの新規 append 限定化」を検証する。実際の windowing は
  // ChatPanel.virtualization.browser.test.tsx が gate する。
  describe("virtualized message list", () => {
    const msg = (
      id: string,
      role: "user" | "assistant" | "system",
      extra: Partial<import("./chatTypes").ChatMessage> = {},
    ) => ({
      id,
      sessionId: "",
      role,
      content: `本文 ${id}`,
      createdAt: new Date().toISOString(),
      ...extra,
    });

    it("renders rows inside a virtualizer-sized container with data-index", () => {
      useChatStore.setState({
        messages: [msg("u1", "user"), msg("a1", "assistant")],
      });

      render(<ChatPanel />);

      const list = screen.getByTestId("chat-virtual-list");
      // 仮想化コンテナは getTotalSize() で明示的な高さを持つ
      expect(list.style.height).toMatch(/^\d+px$/);
      const rows = list.querySelectorAll("[data-index]");
      expect(rows.length).toBe(2);
    });

    it("excludes system and summarized messages from virtual rows, keeping order", () => {
      useChatStore.setState({
        messages: [
          msg("u1", "user"),
          msg("sys1", "system"),
          msg("a1", "assistant", { isSummarized: 1 }),
          msg("a2", "assistant"),
        ],
      });

      render(<ChatPanel />);

      expect(screen.queryByTestId("chat-message-sys1")).not.toBeInTheDocument();
      expect(screen.queryByTestId("chat-message-a1")).not.toBeInTheDocument();
      // 表示対象 (u1, a2) だけが行になり、index が詰まる
      const u1Row = screen
        .getByTestId("chat-message-u1")
        .closest("[data-index]");
      const a2Row = screen
        .getByTestId("chat-message-a2")
        .closest("[data-index]");
      expect(u1Row?.getAttribute("data-index")).toBe("0");
      expect(a2Row?.getAttribute("data-index")).toBe("1");
    });

    // 仮想化では行が scroll out/in で remount されるため、無条件の入場アニメは
    // 過去メッセージの再生 (スクロールでビュンビュン飛ぶ) になる。
    // 「この render で新たに追加された user メッセージ」だけが animate-in を持つ。
    it("marks only newly appended user messages for entrance animation", async () => {
      render(<ChatPanel />);

      await act(async () => {
        useChatStore.setState({ messages: [msg("u1", "user")] });
      });
      expect(
        screen.getByTestId("chat-message-u1").closest("[data-animate-in]"),
      ).not.toBeNull();

      // 次の append で u1 は既知になり、assistant の a1 はそもそも対象外
      await act(async () => {
        useChatStore.setState({
          messages: [msg("u1", "user"), msg("a1", "assistant")],
        });
      });
      expect(
        screen.getByTestId("chat-message-u1").closest("[data-animate-in]"),
      ).toBeNull();
      expect(
        screen.getByTestId("chat-message-a1").closest("[data-animate-in]"),
      ).toBeNull();
    });

    it("does not animate messages arriving from a session load", async () => {
      useChatStore.setState({ isLoadingMessages: true });
      render(<ChatPanel />);
      expect(screen.getByTestId("chat-messages-loading")).toBeInTheDocument();

      // selectSession と同じく、load 完了は messages + isLoadingMessages を
      // 1 回の set で同時更新する
      await act(async () => {
        useChatStore.setState({
          messages: [msg("u1", "user"), msg("u2", "user")],
          isLoadingMessages: false,
        });
      });

      expect(screen.getByTestId("chat-message-u1")).toBeInTheDocument();
      expect(document.querySelectorAll("[data-animate-in]").length).toBe(0);
    });
  });

  // Context Creator（AIコンテキスト提案）は Codex/Snippet 検索ツールを使う
  // エージェント実行なので、現在のモデル/プロバイダが Tool Use 対応のときだけ
  // 押せる。ヘッダー刷新リファクタ (790785ab) で canUseCreator が false 固定に
  // され、対応モデルでも常に無効化されていた回帰を gate する。
  describe("Context Creator のツール対応ゲート", () => {
    afterEach(() => {
      useAiSettingsStore.setState({ settings: null, models: [] });
    });

    it("Tool Use 対応モデルでは AIコンテキスト提案ボタンが有効", () => {
      useAiSettingsStore.setState({
        settings: { ...DEFAULT_AI_SETTINGS, model: "claude-opus-4-8" },
      });

      render(<ChatPanel />);

      expect(
        screen.getByRole("button", { name: "AIコンテキスト提案" }),
      ).toBeEnabled();
    });

    it("Tool Use 非対応モデルでは AIコンテキスト提案ボタンが無効", () => {
      useAiSettingsStore.setState({
        settings: { ...DEFAULT_AI_SETTINGS, model: "deepseek-r1" },
      });

      render(<ChatPanel />);

      expect(
        screen.getByRole("button", { name: "AIコンテキスト提案" }),
      ).toBeDisabled();
    });
  });

  // agentMode を切り替えたら context layer を再構築すること。これが無いと
  // project スコープの pull 委譲（agent ON で synopsis を push しない）がトグル時に
  // 反映されず、非 agent / CLI 送信が古い lastSystemPrompt を流用してしまう。
  it("rebuilds context layers when agentMode is toggled", async () => {
    const refreshSpy = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      agentMode: false,
      refreshContextLayers: refreshSpy,
    });

    render(<ChatPanel />);
    await waitFor(() => expect(refreshSpy).toHaveBeenCalled());
    const callsAfterMount = refreshSpy.mock.calls.length;

    await act(async () => {
      useChatStore.setState({ agentMode: true });
    });

    expect(refreshSpy.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });
});

// シーンスコープのシーン選択は Editor パネル可視時のみエディタへナビゲート
// する。非表示時に openPinned / showPanel("editor") を呼ぶと Editor が強制
// 表示される（openPinned は内部で ensureEditorVisible を呼ぶため両方の経路を
// ガードする必要がある）。scene anchor の同期（treeStore.setActiveScene）は
// 可視状態に関係なく行う。
describe("selectSceneFromChat", () => {
  let originalOpenPinned: ReturnType<typeof useTabStore.getState>["openPinned"];
  let originalShowPanel: ReturnType<
    typeof useLayoutStore.getState
  >["showPanel"];
  let originalEditorOpen: boolean;
  let originalActiveSceneId: ReturnType<
    typeof useTreeStore.getState
  >["activeSceneId"];

  const setEditorVisible = (visible: boolean) => {
    useLayoutStore.setState((s) => ({
      layout: {
        ...s.layout,
        center: { ...s.layout.center, editorOpen: visible },
      },
    }));
  };

  beforeEach(() => {
    originalOpenPinned = useTabStore.getState().openPinned;
    originalShowPanel = useLayoutStore.getState().showPanel;
    originalEditorOpen = useLayoutStore.getState().layout.center.editorOpen;
    originalActiveSceneId = useTreeStore.getState().activeSceneId;
  });

  afterEach(() => {
    useTabStore.setState({ openPinned: originalOpenPinned });
    useLayoutStore.setState({ showPanel: originalShowPanel });
    setEditorVisible(originalEditorOpen);
    useTreeStore.setState({ activeSceneId: originalActiveSceneId });
  });

  it("does not force the editor panel open when it is hidden", () => {
    const openPinned = vi.fn();
    const showPanel = vi.fn();
    useTabStore.setState({ openPinned });
    useLayoutStore.setState({ showPanel });
    setEditorVisible(false);

    selectSceneFromChat("scene-hidden");

    expect(openPinned).not.toHaveBeenCalled();
    expect(showPanel).not.toHaveBeenCalled();
    expect(useLayoutStore.getState().layout.center.editorOpen).toBe(false);
    // scene anchor の同期は可視状態に関係なく行われる
    expect(useTreeStore.getState().activeSceneId).toBe("scene-hidden");
  });

  it("navigates the editor to the scene when the panel is visible", () => {
    const openPinned = vi.fn();
    const showPanel = vi.fn();
    useTabStore.setState({ openPinned });
    useLayoutStore.setState({ showPanel });
    setEditorVisible(true);

    selectSceneFromChat("scene-visible");

    expect(openPinned).toHaveBeenCalledWith("scene-visible");
    expect(showPanel).toHaveBeenCalledWith("editor");
    expect(useTreeStore.getState().activeSceneId).toBe("scene-visible");
  });
});
