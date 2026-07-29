// @vitest-environment happy-dom
/**
 * 仮想化の「配線」と per-delta レンダ契約の決定的 gate
 * (仮想化レビュー 2026-06-10 の確定 finding 対応)。
 *
 * - test-setup.ts の global virtualizer mock は getItemKey を一切評価しない
 *   ため、退行は browser test 4 ケースしか番人が居なかった。ここでは options
 *   を捕捉するローカル mock で配線そのものを assert する (getItemKey の id 化
 *   が崩れると削除/regenerate 後に測定キャッシュが行ズレし、スクロール位置
 *   ジャンプになる)。
 * - perf finding の核心「delta 毎の他行再レンダー (= ReactMarkdown 全件
 *   再パース)」は perfLog の recordMark を捕捉して render 回数を直接数えて
 *   gate する (ChatMessage memo + 安定コールバック契約。ChatPanel.tsx の
 *   NOTE コメント参照)。render-phase setState (entranceAnim) が delta 毎に
 *   二重 render しないことも chatPanel.render の回数で gate する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, fireEvent, screen, within } from "@testing-library/react";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";
import { expectNoA11yViolations } from "@/test-utils/axe";

const virtualizerCapture = vi.hoisted(() => ({
  opts: null as null | {
    count: number;
    estimateSize: () => number;
    getItemKey?: (index: number) => string | number;
  },
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: NonNullable<typeof virtualizerCapture.opts>) => {
    virtualizerCapture.opts = opts;
    const size = opts.estimateSize();
    const items = Array.from({ length: opts.count }, (_, i) => ({
      index: i,
      start: i * size,
      size,
      key: opts.getItemKey ? opts.getItemKey(i) : i,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * size,
      measureElement: () => {},
      scrollToIndex: () => {},
    };
  },
}));

const perfCapture = vi.hoisted(() => ({
  marks: [] as string[],
  counters: [] as string[],
  runtimeControl: null as null | ((payload: unknown) => unknown),
}));
vi.mock("@/lib/perfLog", () => ({
  markStart: () => {},
  markEnd: () => {},
  recordMark: (name: string) => {
    perfCapture.marks.push(name);
  },
  recordCounter: (name: string) => {
    perfCapture.counters.push(name);
  },
  enablePerfLog: () => {},
  disablePerfLog: () => {},
  startPerfSession: () => {},
  endPerfSession: () => null,
  registerRuntimePerformanceControl: (
    name: string,
    control: (payload: unknown) => unknown,
  ) => {
    if (name !== "chat.streamingDraft") {
      throw new Error(`unexpected runtime control: ${name}`);
    }
    perfCapture.runtimeControl = control;
    return () => {
      if (perfCapture.runtimeControl === control) {
        perfCapture.runtimeControl = null;
      }
    };
  },
}));

// ChatInput (TipTap) は仮想化と無関係なので軽量 stub に置換
vi.mock("./components/ChatInput", () => ({
  ChatInput: () => <div data-testid="chat-input-stub" />,
  restoreSceneMentionChips: () => {},
}));

vi.mock("./chatApi", () => ({
  sendChatMessage: vi.fn(),
  listSessions: vi.fn(() => Promise.resolve([])),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  listMessages: vi.fn(() => Promise.resolve([])),
  addMessage: vi.fn(() => Promise.resolve({})),
  updateSessionTitle: vi.fn(() => Promise.resolve()),
  listPinnedCodexEntries: vi.fn(() => Promise.resolve([])),
  listPinnedSnippetEntries: vi.fn(() => Promise.resolve([])),
  listPinnedStickyEntries: vi.fn(() => Promise.resolve([])),
  generateSessionTitle: vi.fn(() => Promise.resolve(null)),
  updateMessageMetadata: vi.fn(() => Promise.resolve()),
}));

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

import { ChatPanel } from "./ChatPanel";
import { useChatStore } from "./chatStore";
import type { ChatMessage as ChatMessageType } from "./chatTypes";
import * as chatApi from "./chatApi";

function msg(
  id: string,
  role: "user" | "assistant" | "system",
  content = `本文 ${id}`,
): ChatMessageType {
  return {
    id,
    sessionId: "",
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}

function growLastMessage() {
  useChatStore.setState((s) => {
    const messages = s.messages.slice();
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = {
      ...last,
      content: last.content + " delta追記",
    };
    return { messages };
  });
}

describe("ChatPanel virtualization contract", () => {
  beforeEach(() => {
    _resetQuiescenceLeasesForTests();
    useChatStore.setState({
      messages: [],
      streamingDraft: null,
      sessions: [],
      isStreaming: false,
      isLoadingMessages: false,
      error: null,
      chatScope: "scene",
      scopeAnchorId: null,
      activeSceneId: "",
      activeSessionId: null,
      inputPinnedEntryIds: [],
      // 非同期の DB / コンテキスト再構築がテストの act 内に着地して
      // render 回数の assert を汚さないよう、store action を stub する
      loadSessions: async () => false,
      selectSession: async () => {},
      refreshContextLayers: async () => null,
    });
    virtualizerCapture.opts = null;
    perfCapture.marks.length = 0;
    perfCapture.counters.length = 0;
    perfCapture.runtimeControl = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetQuiescenceLeasesForTests();
  });

  it("virtualizer 配線: getItemKey が message id を返す", () => {
    useChatStore.setState({
      messages: [
        msg("u1", "user"),
        msg("sys1", "system"),
        msg("a1", "assistant"),
      ],
    });

    render(<ChatPanel />);

    const opts = virtualizerCapture.opts;
    expect(opts).not.toBeNull();
    // system 除外後の件数と id ベースのキー (index キー退行は削除/regenerate
    // 後の測定キャッシュ行ズレ = スクロールジャンプになる)
    expect(opts!.count).toBe(2);
    expect(opts!.getItemKey?.(0)).toBe("u1");
    expect(opts!.getItemKey?.(1)).toBe("a1");
  });

  it("virtual rows expose ordered-list position and the dialog exposes every loaded message", async () => {
    useChatStore.setState({
      messages: [
        { ...msg("old", "assistant", "要約前の古い回答"), isSummarized: 1 },
        msg("u1", "user", "最初の質問"),
        msg("sys", "system", "内部システム記録"),
        msg("a1", "assistant", "最初の回答"),
        msg("u2", "user", "次の質問"),
      ],
    });

    render(<ChatPanel />);

    const virtualList = screen.getByTestId("chat-virtual-list");
    expect(virtualList).toHaveAttribute("role", "list");
    const virtualRows = within(virtualList).getAllByRole("listitem");
    expect(virtualRows).toHaveLength(3);
    expect(virtualRows[0]).toHaveAttribute("aria-posinset", "2");
    expect(virtualRows[0]).toHaveAttribute("aria-setsize", "4");
    expect(virtualRows[2]).toHaveAttribute("aria-posinset", "4");

    fireEvent.click(screen.getByRole("button", { name: "会話全文を読む" }));
    const dialog = screen.getByRole("dialog", {
      name: "チャット会話全文",
    });
    const transcriptItems = within(dialog).getAllByRole("listitem");
    expect(transcriptItems).toHaveLength(4);
    expect(transcriptItems.map((item) => item.textContent)).toEqual([
      expect.stringContaining("要約前の古い回答"),
      expect.stringContaining("最初の質問"),
      expect.stringContaining("最初の回答"),
      expect.stringContaining("次の質問"),
    ]);
    expect(dialog).not.toHaveTextContent("内部システム記録");
    await expectNoA11yViolations(dialog);
  });

  it("closes and invalidates the transcript portal while a lifecycle lease is active", () => {
    useChatStore.setState({
      messages: [msg("u1", "user", "old project message")],
    });
    render(<ChatPanel />);

    const trigger = screen.getByRole("button", { name: "会話全文を読む" });
    fireEvent.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "チャット会話全文" }),
    ).toHaveTextContent("old project message");

    let lease!: ReturnType<typeof acquireQuiescenceLease>;
    act(() => {
      lease = acquireQuiescenceLease("project-load");
    });
    expect(
      screen.queryByRole("dialog", { name: "チャット会話全文" }),
    ).toBeNull();
    expect(trigger).toBeDisabled();

    act(() => {
      useChatStore.setState({
        messages: [msg("u2", "user", "new project message")],
      });
    });
    fireEvent.click(trigger);
    expect(
      screen.queryByRole("dialog", { name: "チャット会話全文" }),
    ).toBeNull();

    act(() => lease.release());
    expect(trigger).toBeEnabled();
    fireEvent.click(trigger);
    const latestDialog = screen.getByRole("dialog", {
      name: "チャット会話全文",
    });
    expect(latestDialog).toHaveTextContent("new project message");
    expect(latestDialog).not.toHaveTextContent("old project message");
  });

  it("メッセージ更新では ChatPanel 本体を再レンダーしない", async () => {
    useChatStore.setState({
      messages: [msg("u1", "user"), msg("a1", "assistant")],
    });
    render(<ChatPanel />);
    // mount 直後の非同期 effect (sessions load 等) を settle させる
    await act(async () => {});

    perfCapture.marks.length = 0;
    await act(async () => {
      growLastMessage();
    });

    // message store / virtualizer は ChatMessageViewport 内に閉じる。履歴の更新で
    // Header / ContextBar / Composer を含む ChatPanel 本体を巻き込まない。
    expect(
      perfCapture.marks.filter((m) => m === "chatPanel.render").length,
    ).toBe(0);
  });

  it("delta で変化していない行の ChatMessage は再レンダーされない", async () => {
    useChatStore.setState({
      messages: [
        msg("u1", "user"),
        msg("a1", "assistant"),
        msg("u2", "user"),
        msg("a2", "assistant"),
      ],
    });
    render(<ChatPanel />);
    await act(async () => {});

    perfCapture.marks.length = 0;
    await act(async () => {
      growLastMessage();
    });

    // memo + 安定コールバック契約: 再パース (ReactMarkdown) は伸長中の
    // 末尾行 1 件に閉じる
    expect(
      perfCapture.marks.filter((m) => m === "chatMessage.render").length,
    ).toBe(1);
  });

  it("streaming draft 更新は ChatPanel を再実行せず末尾行だけ再描画する", async () => {
    useChatStore.setState({
      messages: [msg("u1", "user"), msg("a1", "assistant", "")],
      streamingDraft: { messageId: "a1", content: "" },
      isStreaming: true,
    });
    render(<ChatPanel />);
    await act(async () => {});

    expect(perfCapture.counters).toContain("chat.header.commit");
    expect(perfCapture.counters).toContain("chat.contextBar.commit");
    perfCapture.marks.length = 0;
    perfCapture.counters.length = 0;
    await act(async () => {
      useChatStore.setState({
        streamingDraft: { messageId: "a1", content: "生成中 **本文**" },
      });
    });

    expect(
      perfCapture.marks.filter((m) => m === "chatPanel.render").length,
    ).toBe(0);
    expect(
      perfCapture.marks.filter((m) => m === "chatMessage.render").length,
    ).toBe(1);
    expect(perfCapture.counters).not.toContain("chat.header.commit");
    expect(perfCapture.counters).not.toContain("chat.contextBar.commit");
  });

  it("runtime controlはprepare/delta/cleanupをメモリ内draftだけへ適用し解除する", async () => {
    useChatStore.setState({
      messages: [msg("u1", "user"), msg("a1", "assistant", "")],
    });
    const { unmount } = render(<ChatPanel />);
    await act(async () => {});
    const control = perfCapture.runtimeControl;
    expect(control).not.toBeNull();

    await act(async () => {
      expect(
        control?.({
          action: "prepare",
          messageId: "a1",
          content: "生成中",
        }),
      ).toBe("生成中");
    });
    expect(useChatStore.getState().isStreaming).toBe(true);
    expect(useChatStore.getState().streamingDraft).toEqual({
      messageId: "a1",
      content: "生成中",
    });
    // prepare は isStreaming も切り替えるため、負荷時には親 viewport の
    // commit が次の act まで遅延し得る。実 Electron 性能ハーネスと同じ
    // double-rAF を commit barrier にして、delta 自身の再描画だけを測る。
    await vi.waitFor(() =>
      expect(screen.getByTestId("streaming-indicator")).toBeTruthy(),
    );
    await act(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    perfCapture.marks.length = 0;
    perfCapture.counters.length = 0;
    await act(async () => {
      expect(
        control?.({
          action: "delta",
          messageId: "a1",
          delta: " **本文**",
        }),
      ).toBe("生成中 **本文**");
    });
    expect(useChatStore.getState().streamingDraft?.content).toBe(
      "生成中 **本文**",
    );
    expect(
      perfCapture.marks.filter((mark) => mark === "chatMessage.render"),
    ).toHaveLength(1);
    expect(perfCapture.counters).not.toContain("chat.header.commit");
    expect(perfCapture.counters).not.toContain("chat.contextBar.commit");

    await act(async () => {
      expect(control?.({ action: "cleanup", messageId: "a1" })).toBeNull();
    });
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().streamingDraft).toBeNull();
    expect(chatApi.sendChatMessage).not.toHaveBeenCalled();

    unmount();
    expect(perfCapture.runtimeControl).toBeNull();
  });

  it("runtime controlは実ストリーム中のprepareを拒否し既存draftを変更しない", async () => {
    const existingDraft = {
      messageId: "a2",
      content: "ユーザーの実ストリーム",
    };
    useChatStore.setState({
      messages: [msg("a1", "assistant", ""), msg("a2", "assistant", "")],
      isStreaming: true,
      streamingDraft: existingDraft,
    });
    render(<ChatPanel />);
    await act(async () => {});

    expect(() =>
      perfCapture.runtimeControl?.({
        action: "prepare",
        messageId: "a1",
        content: "",
      }),
    ).toThrow(/real chat stream is active/);
    expect(useChatStore.getState().isStreaming).toBe(true);
    expect(useChatStore.getState().streamingDraft).toBe(existingDraft);
  });

  it("runtime controlのcleanupは後から始まった実ストリームを破壊しない", async () => {
    useChatStore.setState({
      messages: [msg("a1", "assistant", ""), msg("a2", "assistant", "")],
    });
    render(<ChatPanel />);
    await act(async () => {});

    await act(async () => {
      perfCapture.runtimeControl?.({
        action: "prepare",
        messageId: "a1",
        content: "",
      });
    });
    const realDraft = {
      messageId: "a2",
      content: "後から始まった実ストリーム",
    };
    useChatStore.setState({
      isStreaming: true,
      streamingDraft: realDraft,
    });

    await act(async () => {
      expect(
        perfCapture.runtimeControl?.({
          action: "cleanup",
          messageId: "a1",
        }),
      ).toBeNull();
    });
    expect(useChatStore.getState().isStreaming).toBe(true);
    expect(useChatStore.getState().streamingDraft).toBe(realDraft);
  });
});
