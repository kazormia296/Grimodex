// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatDialogs, type ChatContextMenuState } from "./ChatDialogs";
import { useChatStore } from "../chatStore";
import type { ChatMessage } from "../chatTypes";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@/features/codex/CodexExtractionDialog", () => ({
  CodexExtractionDialog: () => null,
}));
vi.mock("@/features/snippets/SnippetExtractionDialog", () => ({
  SnippetExtractionDialog: () => null,
}));
vi.mock("./SessionsPanel", () => ({ SessionsPanel: () => null }));
vi.mock("./PromptPreviewModal", () => ({ PromptPreviewModal: () => null }));

const row = (
  id: string,
  role: "user" | "assistant",
  metadata?: Record<string, unknown>,
): ChatMessage => ({
  id,
  sessionId: "s1",
  role,
  content: `${id}-text`,
  createdAt: "2026-01-01T00:00:00Z",
  ...(metadata ? { metadata: JSON.stringify(metadata) } : {}),
});

const noop = vi.fn();
const renderMenu = (messageId: string) => {
  const contextMenu: ChatContextMenuState = {
    messageId,
    messageRole: "assistant",
    messageContent: "text",
    selectedText: null,
    x: 10,
    y: 10,
  };
  return render(
    <ChatDialogs
      extractionDialog={{} as never}
      snippetDialog={{} as never}
      onSaveCodex={noop}
      onCloseCodex={noop}
      onSaveSnippet={noop}
      onCloseSnippet={noop}
      sessionsPanelOpen={false}
      sceneTitle=""
      activeSceneId=""
      onCloseSessions={noop}
      contextMenu={contextMenu}
      contextMutationsDisabled={false}
      onCloseContextMenu={noop}
      contextActions={{
        onInsert: noop,
        onExtractCodexQuick: noop,
        onExtractCodexDetailed: noop,
        onSaveSnippetQuick: noop,
        onSaveSnippetDetailed: noop,
        onCopy: noop,
        onEdit: noop,
        onDelete: noop,
        onRegenerate: noop,
      }}
      promptViewOpen={false}
      promptViewSnapshot={null}
      onClosePrompt={noop}
    />,
  );
};

describe("ChatDialogs context menu regeneration wiring", () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [
        row("u0", "user"),
        row("a0", "assistant"),
        row("left", "assistant", { runtime_error: "down" }),
      ],
    });
  });

  it("offers regenerate for an assistant row whose user directly precedes", () => {
    renderMenu("a0");
    expect(screen.getByTestId("ctx-regenerate")).toBeInTheDocument();
  });

  it("does not offer regenerate for a row left without a user before it", () => {
    renderMenu("left");
    expect(screen.queryByTestId("ctx-regenerate")).not.toBeInTheDocument();
  });
});
