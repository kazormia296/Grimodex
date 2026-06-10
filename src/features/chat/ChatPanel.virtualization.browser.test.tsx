/**
 * 実 Chromium で動かす ChatPanel メッセージリスト仮想化の gate。
 *
 * gate 対象: メッセージ一覧の非仮想化 (全件 ReactMarkdown レンダ) は perf レビュー
 * 2026-06-10 の確定 finding。仮想化後の invariant は:
 *   (1) windowing — 全 120 件を DOM に出さない (実 virtualizer の番人)
 *   (2) セッション表示時に最下部へアンカーし、動的測定の収束後も末尾に留まる
 *   (3) ストリーミングで末尾 bubble が伸びても最下部に追従する
 *   (4) 上スクロールで履歴を読んでいる間は引き戻さない + 末尾行が DOM から消える
 * happy-dom は virtualizer を全件レンダ mock に差し替えており (test-setup.ts)、
 * スクロール実寸も計算しないため、この 4 点は browser test でしか検証できない。
 *
 * 重要: test-setup-browser.ts は @tanstack/react-virtual を global mock している
 * (全 item レンダ・windowing 無効)。MatrixTable.browser.test.tsx と同じく、
 * このファイルだけ importOriginal で実物に上書きする。(1) と (4) の
 * 「レンダ件数 < 全件」assertion がその番人を兼ねる。
 */
import { vi } from "vitest";
vi.mock(
  "@tanstack/react-virtual",
  async (importOriginal) => await importOriginal(),
);

// TipTap ベースの ChatInput は仮想化と無関係で初期化が重いので stub。
// ChatPanel が named import する restoreSceneMentionChips も提供する。
vi.mock("./components/ChatInput", () => ({
  ChatInput: () => <div data-testid="chat-input-stub" />,
  restoreSceneMentionChips: () => {},
}));

// DB/Tauri に触れる API は全面 mock（store は実物・store action は setState で stub）。
// importOriginal だと DB モジュールが import 時に評価されるため factory で全列挙する。
vi.mock("./chatApi", () => ({
  sendChatMessage: vi.fn(),
  generateSynopsisFromContent: vi.fn(() => Promise.resolve("")),
  sendAgentMessage: vi.fn(),
  sendChatMessageWithThinking: vi.fn(),
  sendChatMessageStream: vi.fn(),
  abortChatStream: vi.fn(),
  generateSessionTitle: vi.fn(() => Promise.resolve(null)),
  listSessions: vi.fn(() => Promise.resolve([])),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  listMessages: vi.fn(() => Promise.resolve([])),
  addMessage: vi.fn(() => Promise.resolve({})),
  deleteMessage: vi.fn(() => Promise.resolve()),
  deleteMessagesFrom: vi.fn(() => Promise.resolve()),
  updateMessageMetadata: vi.fn(() => Promise.resolve()),
  updateSessionTitle: vi.fn(() => Promise.resolve()),
  listPinnedCodexEntries: vi.fn(() => Promise.resolve([])),
  listPinnedSnippetEntries: vi.fn(() => Promise.resolve([])),
  listPinnedStickyEntries: vi.fn(() => Promise.resolve([])),
  pinStickyEntry: vi.fn(() => Promise.resolve()),
  unpinStickyEntry: vi.fn(() => Promise.resolve()),
  pinCodexEntry: vi.fn(() => Promise.resolve()),
  togglePinChildren: vi.fn(() => Promise.resolve()),
  unpinCodexEntry: vi.fn(() => Promise.resolve()),
  unpinCodexEntriesByIds: vi.fn(() => Promise.resolve()),
  listSummaries: vi.fn(() => Promise.resolve([])),
  getSummaryGeneration: vi.fn(() => Promise.resolve(0)),
  addSummary: vi.fn(() => Promise.resolve()),
  markMessagesSummarized: vi.fn(() => Promise.resolve()),
}));

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { ChatPanel } from "./ChatPanel";
import { useChatStore } from "./chatStore";
import { useAiSettingsStore } from "./store";
import type { ChatMessage as ChatMessageType } from "./chatTypes";

const TOTAL = 120;

function makeMessages(n: number): ChatMessageType[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    sessionId: "s1",
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    // 高さがまちまちになるよう行数を変える（動的測定の収束を検証するため）
    content: `メッセージ${i}\n` + "本文の行です。".repeat((i % 5) * 6 + 1),
    createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
  }));
}

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function renderPanel() {
  return render(
    <div style={{ height: "600px", width: "480px", display: "flex" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <ChatPanel />
      </div>
    </div>,
  );
}

async function settleFrames(n = 2) {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }
}

describe("ChatPanel virtualization (real Chromium)", () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: makeMessages(TOTAL),
      isLoadingMessages: false,
      isStreaming: false,
      error: null,
      chatScope: "scene",
      scopeAnchorId: null,
      activeSceneId: "",
      activeSessionId: "s1",
      inputPinnedEntryIds: [],
      // DB へ向かう store action はテストでは何もしない
      loadSessions: async () => {},
      selectSession: async () => {},
      refreshContextLayers: async () => {},
    });
    useAiSettingsStore.setState({ loadSettings: async () => {} });
  });

  it("実 virtualizer が windowing する（全 120 件を DOM に出さない）", async () => {
    renderPanel();

    await waitFor(() => {
      expect(document.querySelectorAll("[data-role]").length).toBeGreaterThan(
        0,
      );
    });
    // viewport 600px / 推定行 ~100px 強 + overscan でも 120 件には遠く届かない
    await waitFor(() => {
      const rendered = document.querySelectorAll("[data-role]").length;
      expect(rendered).toBeLessThan(60);
    });
  });

  it("セッション表示時に最下部へアンカーし、動的測定後も末尾に留まる", async () => {
    renderPanel();
    const scroller = await screen.findByTestId("chat-scroll-container");

    // 動的測定で scrollHeight が伸びても末尾追従が収束すること
    await waitFor(() => {
      expect(scroller.scrollTop).toBeGreaterThan(0);
      expect(distanceFromBottom(scroller)).toBeLessThan(120);
    });
    // 最後のメッセージが実際に視界内にある
    await waitFor(() => {
      const last = screen.getByTestId(`chat-message-m${TOTAL - 1}`);
      const cRect = scroller.getBoundingClientRect();
      const r = last.getBoundingClientRect();
      expect(r.top).toBeLessThan(cRect.bottom);
      expect(r.bottom).toBeGreaterThan(cRect.top);
    });
  });

  it("ストリーミングで末尾 bubble が伸びても最下部に追従する", async () => {
    renderPanel();
    const scroller = await screen.findByTestId("chat-scroll-container");
    await waitFor(() => {
      expect(distanceFromBottom(scroller)).toBeLessThan(120);
    });

    // delta 到着を模す: 末尾 assistant メッセージを段階的に伸長
    for (let step = 0; step < 6; step++) {
      act(() => {
        useChatStore.setState((s) => {
          const messages = s.messages.slice();
          const last = messages[messages.length - 1];
          messages[messages.length - 1] = {
            ...last,
            content: last.content + "\n追記された行です。".repeat(12),
          };
          return { messages, isStreaming: true };
        });
      });
      await settleFrames();
    }

    await waitFor(() => {
      expect(distanceFromBottom(scroller)).toBeLessThan(120);
    });
  });

  it("上スクロール中は引き戻さず、末尾の行は DOM からアンマウントされる", async () => {
    renderPanel();
    const scroller = await screen.findByTestId("chat-scroll-container");
    await waitFor(() => {
      expect(distanceFromBottom(scroller)).toBeLessThan(120);
    });

    // 先頭まで戻って履歴を読む
    scroller.scrollTop = 0;
    await waitFor(() => {
      expect(screen.getByTestId("chat-message-m0")).toBeInTheDocument();
    });
    // windowing: 末尾のメッセージはもう DOM に居ない
    await waitFor(() => {
      expect(
        screen.queryByTestId(`chat-message-m${TOTAL - 1}`),
      ).not.toBeInTheDocument();
    });

    // 末尾が伸びても読んでいる位置から引き戻されない
    act(() => {
      useChatStore.setState((s) => {
        const messages = s.messages.slice();
        const last = messages[messages.length - 1];
        messages[messages.length - 1] = {
          ...last,
          content: last.content + "\n追記された行です。".repeat(12),
        };
        return { messages, isStreaming: true };
      });
    });
    await settleFrames(4);

    expect(scroller.scrollTop).toBeLessThan(50);
    expect(screen.getByTestId("chat-message-m0")).toBeInTheDocument();
  });
});
