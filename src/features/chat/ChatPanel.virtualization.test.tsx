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
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";

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

const perfCapture = vi.hoisted(() => ({ marks: [] as string[] }));
vi.mock("@/lib/perfLog", () => ({
  markStart: () => {},
  markEnd: () => {},
  recordMark: (name: string) => {
    perfCapture.marks.push(name);
  },
  enablePerfLog: () => {},
  disablePerfLog: () => {},
  startPerfSession: () => {},
  endPerfSession: () => null,
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
    useChatStore.setState({
      messages: [],
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
    vi.clearAllMocks();
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

  it("ストリーミング delta では ChatPanel が 1 回だけ render される", async () => {
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

    // entranceAnim の render-phase setState が delta 毎に発火すると 2 になる
    expect(
      perfCapture.marks.filter((m) => m === "chatPanel.render").length,
    ).toBe(1);
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
});
