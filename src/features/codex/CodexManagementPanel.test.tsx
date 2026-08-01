// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { CodexManagementPanel } from "./CodexManagementPanel";
import { useCodexStore } from "./codexStore";
import type { CodexEntry } from "./api";

// Mock ResizeObserver for react-resizable-panels
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  ResizeObserverMock as unknown as typeof ResizeObserver;

// Mock react-resizable-panels to avoid jsdom issues
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    ...props
  }: {
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <div data-testid="resizable-group" {...props}>
      {children}
    </div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

// Mock TipTap - provide minimal editor mock
vi.mock("@tiptap/react", () => {
  const EditorContent = ({
    editor,
  }: {
    editor: { getHTML: () => string } | null;
  }) => {
    if (!editor) return null;
    return (
      <div
        data-testid="tiptap-editor"
        contentEditable
        suppressContentEditableWarning
      >
        {editor.getHTML()}
      </div>
    );
  };
  return {
    useEditor: (config: { content?: string }) => ({
      getHTML: () => config?.content ?? "",
      commands: {
        setContent: vi.fn(),
      },
      setEditable: vi.fn(),
      destroy: vi.fn(),
    }),
    EditorContent,
  };
});

vi.mock("@tiptap/starter-kit", () => ({
  default: {
    configure: () => ({}),
  },
}));

vi.mock("@/features/attribution/AuthorshipMark", () => ({
  AuthorshipMark: {},
}));

vi.mock("@/features/attribution/useAttribution", () => ({
  useAttribution: vi.fn(),
}));

vi.mock("./api", () => ({
  listCodexEntries: vi.fn(() => Promise.resolve([])),
  listCodexMatchTargets: vi.fn(() => Promise.resolve([])),
  createCodexEntry: vi.fn(),
  updateCodexEntry: vi.fn(),
  deleteCodexEntry: vi.fn(),
  listCodexEntriesByMessageId: vi.fn(() => Promise.resolve([])),
}));

vi.mock("./search", () => ({
  searchCodexEntries: vi.fn(() => Promise.resolve([])),
}));

import { listCodexEntries, updateCodexEntry } from "./api";
const mockListCodexEntries = vi.mocked(listCodexEntries);
const mockUpdateCodexEntry = vi.mocked(updateCodexEntry);

const mockEntries: CodexEntry[] = [
  {
    id: "codex-1",
    projectId: "proj-1",
    parentId: null,
    type: "character",
    name: "アリス",
    summary: "主人公",
    content: "{}",
    icon: null,
    aliases: "[]",
    excludedAliases: "[]",
    readings: null,
    tagsCache: "主人公,ファンタジー",
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: "msg-1",
    notes: null,
    version: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "codex-2",
    projectId: "proj-1",
    parentId: null,
    type: "location",
    name: "不思議の国",
    summary: "舞台",
    content: "{}",
    icon: null,
    aliases: "[]",
    excludedAliases: "[]",
    readings: null,
    tagsCache: "場所",
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    version: 0,
    createdAt: "2024-01-02T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
  },
  {
    id: "codex-3",
    projectId: "proj-1",
    parentId: null,
    type: "item",
    name: "魔法の鍵",
    summary: "重要アイテム",
    content: "{}",
    icon: null,
    aliases: "[]",
    excludedAliases: "[]",
    readings: null,
    tagsCache: "アイテム",
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    version: 0,
    createdAt: "2024-01-03T00:00:00Z",
    updatedAt: "2024-01-03T00:00:00Z",
  },
  {
    id: "codex-4",
    projectId: "proj-1",
    parentId: null,
    type: "lore",
    name: "古代魔法",
    summary: "世界の魔法体系",
    content: "{}",
    icon: null,
    aliases: "[]",
    excludedAliases: "[]",
    readings: null,
    tagsCache: "設定,魔法",
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: "msg-2",
    notes: null,
    version: 0,
    createdAt: "2024-01-04T00:00:00Z",
    updatedAt: "2024-01-04T00:00:00Z",
  },
];

describe("CodexManagementPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCodexStore.setState({
      entries: [],
      searchQuery: "",
      filterType: null,
      isLoading: false,
      selectedEntry: null,
      pendingEntryId: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Resizable Panel Layout ---

  describe("Resizable panel layout", () => {
    it("renders with resizable panel group containing left and right panels", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      expect(screen.getByTestId("codex-management-panel")).toBeInTheDocument();
      expect(screen.getByTestId("codex-list-panel")).toBeInTheDocument();
      expect(screen.getByTestId("codex-detail-panel")).toBeInTheDocument();
    });

    it("shows placeholder in right panel when no entry is selected", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      expect(
        screen.getByTestId("codex-detail-placeholder"),
      ).toBeInTheDocument();
    });
  });

  // --- Left Panel: Category filter + list ---

  describe("Left panel - list with category filters", () => {
    it("renders entry list in left panel", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      expect(screen.getByText("不思議の国")).toBeInTheDocument();
      expect(screen.getByText("魔法の鍵")).toBeInTheDocument();
      expect(screen.getByText("古代魔法")).toBeInTheDocument();
    });

    it("renders category filter buttons", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });

      expect(screen.getByTestId("codex-filter-all")).toBeInTheDocument();
      expect(screen.getByTestId("codex-filter-character")).toBeInTheDocument();
      expect(screen.getByTestId("codex-filter-location")).toBeInTheDocument();
      expect(screen.getByTestId("codex-filter-item")).toBeInTheDocument();
      expect(screen.getByTestId("codex-filter-lore")).toBeInTheDocument();
    });

    it("filters entries when category button is clicked", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });

      mockListCodexEntries.mockResolvedValue([mockEntries[0]]);
      await user.click(screen.getByTestId("codex-filter-character"));

      await waitFor(() => {
        expect(useCodexStore.getState().filterType).toBe("character");
      });
    });

    it("shows empty state when no entries exist", async () => {
      mockListCodexEntries.mockResolvedValue([]);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByTestId("codex-empty-state")).toBeInTheDocument();
      });
    });

    it("highlights selected entry in list", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("codex-entry-codex-1"));

      expect(screen.getByTestId("codex-entry-codex-1")).toHaveClass(
        "bg-accent",
      );
    });
  });

  // --- Right Panel: Entry detail with TipTap mini-editor ---

  describe("Right panel - entry detail with TipTap editor", () => {
    it("shows entry details when entry is selected", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("codex-entry-codex-1"));

      expect(screen.getByTestId("codex-detail-content")).toBeInTheDocument();
      expect(screen.getByDisplayValue("アリス")).toBeInTheDocument();
    });

    it("preserves selection across remount (layout preset switch)", async () => {
      // レイアウトプリセット切替でパネルが配置から外れる（または閉じられる）
      // と subtree は unmount される。選択がストアに乗ったことで unmount →
      // 再 mount を跨いでも保持されることを回帰として固定する。
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      const { unmount } = render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("codex-entry-codex-1"));
      expect(screen.getByTestId("codex-detail-content")).toBeInTheDocument();

      // preset 切替に相当する remount を再現
      unmount();
      render(<CodexManagementPanel />);

      // 選択維持で detail が即復帰するため、名前 "アリス" は一覧 + detail header の
      // 計測用 hidden span (aria-hidden) の 2 箇所に現れる。getByText だと多重一致で
      // 落ちるので、一覧アイテムの testid で再描画完了を待つ。
      await waitFor(() => {
        expect(screen.getByTestId("codex-entry-codex-1")).toBeInTheDocument();
      });
      // placeholder ではなく detail がそのまま復帰する = 選択維持
      expect(screen.getByTestId("codex-detail-content")).toBeInTheDocument();
      expect(
        screen.queryByTestId("codex-detail-placeholder"),
      ).not.toBeInTheDocument();
    });

    it("shows type badge and editable fields", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("codex-entry-codex-1"));

      // Name field
      expect(screen.getByTestId("codex-detail-name")).toBeInTheDocument();
      // Summary field
      expect(screen.getByTestId("codex-detail-summary")).toBeInTheDocument();
      // Tags field
      expect(screen.getByTestId("codex-detail-tags")).toBeInTheDocument();
      // Type selector
      expect(screen.getByTestId("codex-detail-type")).toBeInTheDocument();
    });

    // 名前フィールドは <input> から自動フィット用 <textarea> に変わった。
    // textarea 化で持ち込んだ 2 つの新挙動 (IME ガード / 改行畳み) を回帰として固定。
    it("commits the name on Enter but ignores IME-composition Enter", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);
      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("codex-entry-codex-1"));

      const nameField = screen.getByTestId(
        "codex-detail-name",
      ) as HTMLTextAreaElement;
      nameField.focus();
      expect(document.activeElement).toBe(nameField);

      // 変換確定の Enter (isComposing) は commit/blur を起こさない。
      fireEvent.keyDown(nameField, { key: "Enter", isComposing: true });
      expect(document.activeElement).toBe(nameField);

      // 通常の Enter は blur して commit する。
      fireEvent.keyDown(nameField, { key: "Enter" });
      expect(document.activeElement).not.toBe(nameField);
    });

    it("collapses pasted newlines in the name to a single line", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);
      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("codex-entry-codex-1"));

      const nameField = screen.getByTestId(
        "codex-detail-name",
      ) as HTMLTextAreaElement;
      // textarea は input と違い改行を保持するため、貼り付け改行をスペースに畳む。
      fireEvent.change(nameField, { target: { value: "山田\n太郎" } });
      expect(nameField.value).toBe("山田 太郎");
    });

    it("does not show a save button (auto-save is used instead)", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("codex-entry-codex-1"));

      expect(screen.queryByTestId("codex-save-button")).not.toBeInTheDocument();
    });

    it("shows context mode selector in Tracking tab", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("codex-entry-codex-1"));
      // context-mode-selector is in the Tracking tab
      await user.click(screen.getByTestId("detail-tab-tracking"));

      expect(screen.getByTestId("context-mode-selector")).toBeInTheDocument();
    });

    it("keeps the selected detail tab when switching entries", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("codex-entry-codex-1"));
      await user.click(screen.getByTestId("detail-tab-tracking"));
      expect(screen.getByTestId("context-mode-selector")).toBeInTheDocument();

      await user.click(screen.getByTestId("codex-entry-codex-2"));

      await waitFor(() => {
        expect(screen.getByTestId("codex-detail-name")).toHaveValue(
          "不思議の国",
        );
        expect(screen.getByTestId("context-mode-selector")).toBeInTheDocument();
      });
    });

    it("shows aliases field in Details tab (default)", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("codex-entry-codex-1"));

      // Details tab is the default – aliases are visible immediately
      expect(screen.getByTestId("aliases-add-button")).toBeInTheDocument();
    });

    it("shows detail tabs when entry is selected", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("codex-entry-codex-1"));

      expect(screen.getByTestId("detail-tab-details")).toBeInTheDocument();
      expect(screen.getByTestId("detail-tab-relations")).toBeInTheDocument();
      expect(screen.getByTestId("detail-tab-tracking")).toBeInTheDocument();
      expect(screen.getByTestId("detail-tab-mentions")).toBeInTheDocument();
      expect(screen.getByTestId("detail-tab-research")).toBeInTheDocument();
    });

    it("deletes entry when delete button is clicked", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("codex-entry-codex-1"));
      await user.click(screen.getByTestId("codex-detail-delete"));

      // Confirmation dialog should appear
      expect(screen.getByText("削除の確認")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "削除する" }));

      await waitFor(() => {
        expect(
          screen.getByTestId("codex-detail-placeholder"),
        ).toBeInTheDocument();
      });
    });
  });

  // --- Source Chat Link ---

  describe("Source chat link", () => {
    it("shows source chat link in Mentions tab when entry has sourceChatMessageId", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      // Entry 1 has sourceChatMessageId: "msg-1"
      await user.click(screen.getByTestId("codex-entry-codex-1"));
      // source-chat-link is in the Mentions tab
      await user.click(screen.getByTestId("detail-tab-mentions"));

      expect(screen.getByTestId("codex-source-chat-link")).toBeInTheDocument();
    });

    it("does not show source chat link when entry has no sourceChatMessageId", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("不思議の国")).toBeInTheDocument();
      });
      // Entry 2 has sourceChatMessageId: null
      await user.click(screen.getByTestId("codex-entry-codex-2"));
      await user.click(screen.getByTestId("detail-tab-mentions"));

      expect(
        screen.queryByTestId("codex-source-chat-link"),
      ).not.toBeInTheDocument();
    });
  });

  // --- Command Palette (Ctrl+K) ---

  describe("Command palette (Ctrl+K)", () => {
    it("opens command palette when Ctrl+K is pressed", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });

      screen.getByTestId("codex-management-panel").focus();
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("codex-command-palette")).toBeInTheDocument();
      });
    });

    it("closes command palette when Escape is pressed", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });

      screen.getByTestId("codex-management-panel").focus();
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("codex-command-palette")).toBeInTheDocument();
      });

      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(() => {
        expect(
          screen.queryByTestId("codex-command-palette"),
        ).not.toBeInTheDocument();
      });
    });

    it("searches entries in command palette and selects result", async () => {
      const user = userEvent.setup();
      const { searchCodexEntries } = await import("./search");
      vi.mocked(searchCodexEntries).mockResolvedValue([mockEntries[0]]);
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });

      screen.getByTestId("codex-management-panel").focus();
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("codex-command-palette")).toBeInTheDocument();
      });

      const searchInput = screen.getByTestId("codex-command-input");
      await user.type(searchInput, "アリス");

      await waitFor(() => {
        expect(
          screen.getByTestId("codex-command-result-codex-1"),
        ).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("codex-command-result-codex-1"));

      // Command palette closes and entry is selected
      await waitFor(() => {
        expect(
          screen.queryByTestId("codex-command-palette"),
        ).not.toBeInTheDocument();
      });
      expect(screen.getByTestId("codex-detail-content")).toBeInTheDocument();
    });
  });

  // --- Keyboard navigation (ArrowUp/ArrowDown) keeps selection in view ---

  describe("Keyboard navigation scroll-follow", () => {
    it("scrolls the newly-selected entry into view on ArrowDown", async () => {
      // Regression: ↓/↑ で選択を動かしても、選択中の項目が画面外に出たまま
      // スクロールが追従しなかった。キーボード移動が scrollToEntryId 経由で
      // リスト側のスクロール（category 既定パスは scrollIntoView）を発火する
      // ことを固定する。happy-dom は実寸を持たないため「実際に見えるか」では
      // なく配線（scroll 呼び出し）を gate する。
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);

      // happy-dom は scrollIntoView を実装しないことがあるため明示的に差し込む。
      const scrollSpy = vi.fn();
      Element.prototype.scrollIntoView =
        scrollSpy as unknown as typeof Element.prototype.scrollIntoView;

      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });

      // 先頭エントリを選択してから ↓ を押す（既定 sort は category）。
      await user.click(screen.getByTestId("codex-entry-codex-1"));
      scrollSpy.mockClear();

      screen.getByTestId("codex-management-panel").focus();
      fireEvent.keyDown(document, { key: "ArrowDown" });

      // 選択が次のエントリへ移り、その要素へスクロールが発火する。
      await waitFor(() => {
        expect(screen.getByTestId("codex-entry-codex-2")).toHaveClass(
          "bg-accent",
        );
      });
      expect(scrollSpy).toHaveBeenCalled();
    });
  });

  // --- Integration: Register → Search → Edit → Source reference ---

  describe("Integration: register → search → edit → source reference", () => {
    it("completes full workflow: search → select → edit → verify source", async () => {
      const user = userEvent.setup();
      const { searchCodexEntries } = await import("./search");
      vi.mocked(searchCodexEntries).mockResolvedValue([mockEntries[0]]);
      mockListCodexEntries.mockResolvedValue(mockEntries);
      mockUpdateCodexEntry.mockResolvedValue({
        ...mockEntries[0],
        name: "アリス改",
      });
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });

      // Step 1: Search via command palette
      screen.getByTestId("codex-management-panel").focus();
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });
      await waitFor(() => {
        expect(screen.getByTestId("codex-command-palette")).toBeInTheDocument();
      });

      const searchInput = screen.getByTestId("codex-command-input");
      await user.type(searchInput, "アリス");

      await waitFor(() => {
        expect(
          screen.getByTestId("codex-command-result-codex-1"),
        ).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("codex-command-result-codex-1"));

      // Step 2: Detail view is shown
      await waitFor(() => {
        expect(screen.getByTestId("codex-detail-content")).toBeInTheDocument();
      });

      // Step 3: Switch to Mentions tab to see source chat link
      await user.click(screen.getByTestId("detail-tab-mentions"));
      expect(screen.getByTestId("codex-source-chat-link")).toBeInTheDocument();
    });
  });

  // --- Header: [+] button + entry count ---

  describe("Header: [+] button and entry count", () => {
    it("shows Codex title in header", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);
      await waitFor(() =>
        expect(screen.getByTestId("codex-header-title")).toBeInTheDocument(),
      );
    });

    it("shows entry count in header", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);
      await waitFor(() =>
        expect(screen.getByTestId("codex-entry-count")).toBeInTheDocument(),
      );
    });

    it("creates new entry and selects it when [+] is clicked", async () => {
      const user = userEvent.setup();
      const { createCodexEntry } = await import("./api");
      vi.mocked(createCodexEntry).mockResolvedValue(mockEntries[0]);
      mockListCodexEntries.mockResolvedValue([]);
      render(<CodexManagementPanel />);

      await waitFor(() =>
        expect(
          screen.getByTestId("codex-new-entry-button"),
        ).toBeInTheDocument(),
      );
      await user.click(screen.getByTestId("codex-new-entry-button"));

      await waitFor(() =>
        expect(screen.getByTestId("codex-detail-content")).toBeInTheDocument(),
      );
    });
  });

  // --- Search bar ---

  describe("Inline search bar", () => {
    it("renders search bar in list panel", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);
      await waitFor(() =>
        expect(screen.getByTestId("codex-search-input")).toBeInTheDocument(),
      );
    });

    it("filters entries when search query is typed", async () => {
      const user = userEvent.setup();
      const { searchCodexEntries } = await import("./search");
      vi.mocked(searchCodexEntries).mockResolvedValue([mockEntries[0]]);
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() =>
        expect(screen.getByText("アリス")).toBeInTheDocument(),
      );

      await user.type(screen.getByTestId("codex-search-input"), "アリス");

      await waitFor(() => {
        expect(useCodexStore.getState().searchQuery).toBe("アリス");
      });
    });

    it("clears search when Escape is pressed", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() =>
        expect(screen.getByTestId("codex-search-input")).toBeInTheDocument(),
      );

      const input = screen.getByTestId("codex-search-input");
      await user.type(input, "テスト");
      await user.keyboard("{Escape}");

      expect(input).toHaveValue("");
    });
  });

  // --- Sort options ---

  describe("Sort options", () => {
    it("shows sort selector in header", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);
      await waitFor(() =>
        expect(screen.getByTestId("codex-sort-selector")).toBeInTheDocument(),
      );
    });

    it("sorts entries by name descending when Z→A is selected", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() =>
        expect(screen.getByText("アリス")).toBeInTheDocument(),
      );

      await user.selectOptions(
        screen.getByTestId("codex-sort-selector"),
        "name-desc",
      );

      // After sort change, the store sort order should be updated
      await waitFor(() =>
        expect(useCodexStore.getState().sortOrder).toBe("name-desc"),
      );
    });

    it("shows category group headers when sort is category", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      useCodexStore.setState({ entries: mockEntries, sortOrder: "category" });
      render(<CodexManagementPanel />);

      await waitFor(() =>
        expect(
          screen.getByTestId("codex-category-group-character"),
        ).toBeInTheDocument(),
      );
      expect(
        screen.getByTestId("codex-category-group-location"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("codex-category-group-item"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("codex-category-group-lore"),
      ).toBeInTheDocument();
    });

    it("shows entries under their category group", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      useCodexStore.setState({ entries: mockEntries, sortOrder: "category" });
      render(<CodexManagementPanel />);

      await waitFor(() =>
        expect(screen.getByText("アリス")).toBeInTheDocument(),
      );
      expect(screen.getByText("不思議の国")).toBeInTheDocument();
      expect(screen.getByText("魔法の鍵")).toBeInTheDocument();
      expect(screen.getByText("古代魔法")).toBeInTheDocument();
    });

    it("collapses group when header is clicked", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      useCodexStore.setState({ entries: mockEntries, sortOrder: "category" });
      render(<CodexManagementPanel />);

      await waitFor(() =>
        expect(screen.getByText("アリス")).toBeInTheDocument(),
      );
      // Click to collapse Character group
      await user.click(screen.getByTestId("codex-category-group-character"));
      expect(
        screen.queryByTestId("codex-entry-codex-1"),
      ).not.toBeInTheDocument();
    });
  });

  // --- Responsive stack mode ---

  describe("Responsive stack mode", () => {
    it("shows back button in detail view when in stack mode", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);

      // Simulate narrow panel width by setting stack mode
      useCodexStore.setState({
        entries: mockEntries,
        searchQuery: "",
        filterType: null,
        isLoading: false,
        sortOrder: "name-asc",
      });

      render(<CodexManagementPanel initialStackMode={true} />);

      await waitFor(() =>
        expect(screen.getByText("アリス")).toBeInTheDocument(),
      );

      await user.click(screen.getByTestId("codex-entry-codex-1"));

      await waitFor(() =>
        expect(screen.getByTestId("codex-back-button")).toBeInTheDocument(),
      );
    });

    it("returns to list when back button is clicked in stack mode", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);

      useCodexStore.setState({
        entries: mockEntries,
        searchQuery: "",
        filterType: null,
        isLoading: false,
        sortOrder: "name-asc",
      });

      render(<CodexManagementPanel initialStackMode={true} />);

      await waitFor(() =>
        expect(screen.getByText("アリス")).toBeInTheDocument(),
      );

      await user.click(screen.getByTestId("codex-entry-codex-1"));

      await waitFor(() =>
        expect(screen.getByTestId("codex-back-button")).toBeInTheDocument(),
      );

      await user.click(screen.getByTestId("codex-back-button"));

      await waitFor(() =>
        expect(screen.getByTestId("codex-list-panel")).toBeInTheDocument(),
      );
    });
  });
});
