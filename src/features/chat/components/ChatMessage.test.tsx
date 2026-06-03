// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatMessage } from "./ChatMessage";
import type { ChatMessage as ChatMessageType } from "../chatTypes";
import {
  handleCopyWithAttribution,
  copyChatMessageWithAttribution,
} from "@/lib/clipboardAttribution";

// --- clipboard producers: spy so we can assert the source passed in ---
vi.mock("@/lib/clipboardAttribution", () => ({
  handleCopyWithAttribution: vi.fn(),
  copyChatMessageWithAttribution: vi.fn(() => Promise.resolve()),
}));

// --- strip heavy / irrelevant rendering deps ---
vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("remark-gfm", () => ({ default: () => ({}) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@/lib/perfLog", () => ({ recordMark: vi.fn() }));

// Surface onInsert as a clickable button so we can assert the inserted text is
// stripped of pseudo tool markup (editor-insert leak matters for a writing tool).
vi.mock("./ChatMessageActions", () => ({
  ChatMessageActions: ({ onInsert }: { onInsert?: () => void }) =>
    onInsert ? (
      <button type="button" data-testid="insert-btn" onClick={onInsert}>
        insert
      </button>
    ) : null,
}));
vi.mock("./MessageBadge", () => ({ MessageBadge: () => null }));
vi.mock("./ToolCallBlock", () => ({ ToolCallBlock: () => null }));
vi.mock("./ThinkingBlock", () => ({ ThinkingBlock: () => null }));
vi.mock("./SummaryBlock", () => ({ SummaryBlock: () => null }));
// Surface the SelectionToolbar's onCopy callback as a clickable button so we
// can assert it routes through copyChatMessageWithAttribution (not bare writeText).
vi.mock("./SelectionToolbar", () => ({
  SelectionToolbar: ({ onCopy }: { onCopy: (text: string) => void }) => (
    <button
      type="button"
      data-testid="selection-copy"
      onClick={() => onCopy("選択テキスト")}
    >
      copy
    </button>
  ),
}));

vi.mock("@/features/chat/hooks/useCodexMarkdownComponents", () => ({
  useCodexMarkdownComponents: () => ({}),
}));
// Truthy selectionInfo so the assistant SelectionToolbar renders.
vi.mock("@/features/chat/hooks/useTextSelection", () => ({
  useTextSelection: () => ({ selectionInfo: { text: "選択テキスト" } }),
}));
vi.mock("@/features/editor/editorStore", () => ({
  useEditorStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ showGhostPreview: vi.fn(), clearGhostPreview: vi.fn() }),
}));
vi.mock("../chatStore", () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ agentMode: false }),
}));
vi.mock("../store", () => ({
  useAiSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ settings: { model: "claude-x" } }),
}));

const fakeMsg = (
  overrides: Partial<ChatMessageType> = {},
): ChatMessageType => ({
  id: "m1",
  sessionId: "s1",
  role: "assistant",
  content: "本文テキスト",
  model: "claude-x",
  metadata: null,
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

function renderMsg(
  overrides: Partial<ChatMessageType> = {},
  onInsert: (content: string, id: string) => void = vi.fn(),
) {
  return render(
    <ChatMessage
      msg={fakeMsg(overrides)}
      isStreaming={false}
      onInsert={onInsert}
    />,
  );
}

const LEAKED_CONTENT =
  "検索を行います。\n" +
  '<tool_call>\n{"name": "web_search", "arguments": {"query": "雨ざらし 意味"}}\n</tool_call>\n' +
  '<tool_response>\n{"success": true, "results": []}\n</tool_response>\n' +
  "検索結果をお伝えします。";

describe("ChatMessage — コピー時の Authorship 伝搬", () => {
  beforeEach(() => vi.clearAllMocks());

  it("assistant メッセージのネイティブ copy は source='ai' を注入する", () => {
    renderMsg({ id: "m1", role: "assistant" });
    fireEvent.copy(screen.getByTestId("chat-message-m1"));
    expect(handleCopyWithAttribution).toHaveBeenCalledWith(
      expect.anything(),
      "ai",
    );
  });

  it("user メッセージのネイティブ copy は source='human' を注入する", () => {
    renderMsg({ id: "m2", role: "user" });
    fireEvent.copy(screen.getByTestId("chat-message-m2"));
    expect(handleCopyWithAttribution).toHaveBeenCalledWith(
      expect.anything(),
      "human",
    );
  });

  it("SelectionToolbar の Copy は素の writeText ではなく属性付きコピーに繋がる", () => {
    renderMsg({ id: "m3", role: "assistant", model: "claude-x" });
    fireEvent.click(screen.getByTestId("selection-copy"));
    expect(copyChatMessageWithAttribution).toHaveBeenCalledWith(
      "選択テキスト",
      "m3",
      "claude-x",
    );
  });
});

describe("ChatMessage — 擬似ツール記法の除去", () => {
  beforeEach(() => vi.clearAllMocks());

  it("assistant 本文の <tool_call>/<tool_response> はレンダーされず、回答だけが残る", () => {
    renderMsg({ id: "m1", role: "assistant", content: LEAKED_CONTENT });
    const bubble = screen.getByTestId("chat-message-m1");
    expect(bubble.textContent).not.toContain("tool_call");
    expect(bubble.textContent).not.toContain("tool_response");
    expect(bubble.textContent).not.toContain("web_search");
    expect(bubble.textContent).not.toContain('"success"');
    expect(bubble.textContent).toContain("検索を行います。");
    expect(bubble.textContent).toContain("検索結果をお伝えします。");
  });

  it("挿入 (onInsert) には記法除去後のテキストが渡る", () => {
    const onInsert = vi.fn();
    renderMsg(
      { id: "m1", role: "assistant", content: LEAKED_CONTENT },
      onInsert,
    );
    fireEvent.click(screen.getByTestId("insert-btn"));
    expect(onInsert).toHaveBeenCalledTimes(1);
    const inserted = onInsert.mock.calls[0][0] as string;
    expect(inserted).not.toContain("<tool_call>");
    expect(inserted).not.toContain("web_search");
    expect(inserted).toContain("検索結果をお伝えします。");
  });

  it("user 本文は除去せず原文のまま扱う", () => {
    const onInsert = vi.fn();
    renderMsg(
      { id: "m2", role: "user", content: "<tool_call>これは原文</tool_call>" },
      onInsert,
    );
    const bubble = screen.getByTestId("chat-message-m2");
    // user メッセージは加工せずそのまま（万一の貼り付け内容を壊さない）。
    expect(bubble.textContent).toContain("これは原文");
  });
});
