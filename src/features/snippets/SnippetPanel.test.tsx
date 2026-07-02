// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { SnippetPanel } from "./SnippetPanel";
import { useSnippetStore } from "./snippetStore";
import type { Snippet } from "./api";
import { axe } from "@/test-utils/axe";

vi.mock("@/lib/clipboardAttribution", () => ({
  copyWithAttribution: vi.fn(),
  handleCopyWithAttribution: vi.fn(),
}));

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
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

vi.mock("./SnippetDetailContent", () => ({
  SnippetDetailContent: () => (
    <div data-testid="snippet-detail-content">detail</div>
  ),
}));

vi.mock("./SnippetContextMenu", () => ({
  SnippetContextMenu: ({
    onClose,
  }: {
    snippet: Snippet;
    x: number;
    y: number;
    onClose: () => void;
    onEdit: (s: Snippet) => void;
    onDelete: (id: string) => void;
  }) => (
    <div data-testid="snippet-context-menu">
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (
    selector: (s: { nodes: []; setActiveScene: () => void }) => unknown,
  ) => selector({ nodes: [], setActiveScene: vi.fn() }),
}));

vi.mock("@/features/editor/editorStore", () => ({
  useEditorStore: (
    selector: (s: { insertFromSnippet: () => boolean }) => unknown,
  ) => selector({ insertFromSnippet: vi.fn(() => true) }),
  // Allow getState() calls in keyboard handlers
}));

vi.mock("./snippetStore", async () => {
  const { create } = await import("zustand");
  const store = create(() => ({
    entries: [] as Snippet[],
    searchQuery: "",
    isLoading: false,
    sourceFilter: "all" as const,
    sortOrder: "recent" as const,
    selectedSnippet: null as Snippet | null,
    loadEntries: vi.fn(),
    ensureEntriesLoaded: vi.fn(),
    search: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    incrementUsageCount: vi.fn(),
    setSourceFilter: vi.fn(),
    setSortOrder: vi.fn(),
    setSelectedSnippet: vi.fn(),
  }));
  return { useSnippetStore: store };
});

const fakeSnippet = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: "snippet-1",
  projectId: "default-project",
  title: "テストスニペット",
  content: "スニペット内容",
  tagsCache: null,
  contentSource: null,
  sceneId: null,
  sourceChatMessageId: null,
  usageCount: 0,
  version: 0,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  ...overrides,
});

describe("SnippetPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSnippetStore.setState({
      entries: [],
      searchQuery: "",
      isLoading: false,
      sourceFilter: "all",
      sortOrder: "recent",
      selectedSnippet: null,
    });
  });

  it("renders the panel with search input", () => {
    render(<SnippetPanel />);
    expect(screen.getByTestId("snippet-search-input")).toBeInTheDocument();
  });

  it("has no ARIA-attribute violations on the cards (aria-current allowed; no prohibited aria-label on the generic div)", async () => {
    useSnippetStore.setState({
      entries: [
        fakeSnippet({ id: "s1" }),
        fakeSnippet({ id: "s2", title: "別スニペット" }),
      ],
      selectedSnippet: fakeSnippet({ id: "s1" }),
    });
    const { container } = render(<SnippetPanel />);
    // ARIA 属性 + nested-interactive に限定 (色コントラスト等の無関係な指摘で
    // 落とさない)。nested-interactive: role="group" は構造ロールなので nested
    // アクションボタンを含んでも違反にならないことを gate する。
    const results = await axe(container, {
      runOnly: {
        type: "rule",
        values: [
          "aria-prohibited-attr",
          "aria-allowed-attr",
          "aria-required-attr",
          "aria-roles",
          "aria-valid-attr-value",
          "nested-interactive",
        ],
      },
    });
    expect(results).toHaveNoViolations();
  });

  it("roving: ArrowDown moves DOM focus onto the card (role=group, named) so SR reaches it", async () => {
    useSnippetStore.setState({
      entries: [
        fakeSnippet({ id: "s1", title: "最初のスニペット" }),
        fakeSnippet({ id: "s2", title: "二番目のスニペット" }),
      ],
    });
    const user = userEvent.setup();
    render(<SnippetPanel />);

    const card1 = screen.getByTestId("snippet-item-s1");
    expect(card1).toHaveAttribute("role", "group");
    expect(card1).toHaveAttribute("aria-label", "最初のスニペット");

    screen.getByTestId("snippet-panel").focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(card1);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByTestId("snippet-item-s2"));
  });

  it("inline copy/delete buttons are removed from the Tab order (tabIndex -1)", () => {
    useSnippetStore.setState({ entries: [fakeSnippet({ id: "s1" })] });
    render(<SnippetPanel />);
    expect(screen.getByTestId("snippet-copy-s1")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(screen.getByTestId("snippet-delete-s1")).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  it("Ctrl+C copies the focused snippet via an explicit keyboard handler", async () => {
    const { copyWithAttribution } = await import("@/lib/clipboardAttribution");
    useSnippetStore.setState({
      entries: [
        fakeSnippet({ id: "s1", content: "コピー対象", contentSource: "ai" }),
      ],
    });
    const user = userEvent.setup();
    render(<SnippetPanel />);
    screen.getByTestId("snippet-panel").focus();
    await user.keyboard("{ArrowDown}"); // focusedIndex -> 0
    await user.keyboard("{Control>}c{/Control}");
    expect(copyWithAttribution).toHaveBeenCalledWith("コピー対象", "ai");
  });

  it("renders the header with title and new button", () => {
    render(<SnippetPanel />);
    expect(screen.getByText("Snippets")).toBeInTheDocument();
    expect(screen.getByTestId("snippet-new-button")).toBeInTheDocument();
  });

  it("shows filtered count in header", () => {
    useSnippetStore.setState({
      entries: [
        fakeSnippet({ id: "snippet-1" }),
        fakeSnippet({ id: "snippet-2" }),
      ],
    });
    render(<SnippetPanel />);
    expect(screen.getByTestId("snippet-count")).toHaveTextContent("2");
  });

  it("renders source filter pills", () => {
    render(<SnippetPanel />);
    expect(screen.getByTestId("snippet-filter-all")).toBeInTheDocument();
    expect(screen.getByTestId("snippet-filter-from-chat")).toBeInTheDocument();
    expect(
      screen.getByTestId("snippet-filter-from-editor"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("snippet-filter-manual")).toBeInTheDocument();
  });

  it("renders sort dropdown", () => {
    render(<SnippetPanel />);
    expect(screen.getByTestId("snippet-sort-selector")).toBeInTheDocument();
  });

  it("calls setSourceFilter when filter pill is clicked", async () => {
    const setSourceFilter = vi.fn();
    useSnippetStore.setState({ setSourceFilter });
    const user = userEvent.setup();

    render(<SnippetPanel />);
    await user.click(screen.getByTestId("snippet-filter-from-chat"));
    expect(setSourceFilter).toHaveBeenCalledWith("from-chat");
  });

  it("calls setSortOrder when sort dropdown changes", async () => {
    const setSortOrder = vi.fn();
    useSnippetStore.setState({ setSortOrder });
    const user = userEvent.setup();

    render(<SnippetPanel />);
    await user.selectOptions(
      screen.getByTestId("snippet-sort-selector"),
      "oldest",
    );
    expect(setSortOrder).toHaveBeenCalledWith("oldest");
  });

  it("calls ensureEntriesLoaded on mount (同時 mount のクエリ重複を dedup する経路)", () => {
    const ensureEntriesLoaded = vi.fn();
    useSnippetStore.setState({ ensureEntriesLoaded });
    render(<SnippetPanel />);
    expect(ensureEntriesLoaded).toHaveBeenCalled();
  });

  it("shows empty state when no snippets", () => {
    render(<SnippetPanel />);
    expect(screen.getByTestId("snippet-empty-state")).toBeInTheDocument();
  });

  it("displays snippet list", () => {
    useSnippetStore.setState({
      entries: [
        fakeSnippet({ id: "snippet-1", title: "一つ目" }),
        fakeSnippet({ id: "snippet-2", title: "二つ目" }),
      ],
    });

    render(<SnippetPanel />);
    expect(screen.getByText("一つ目")).toBeInTheDocument();
    expect(screen.getByText("二つ目")).toBeInTheDocument();
  });

  it("displays tags on snippet items", () => {
    useSnippetStore.setState({
      entries: [
        fakeSnippet({
          id: "snippet-1",
          tagsCache: JSON.stringify([
            { name: "伏線", color: null },
            { name: "キャラ", color: null },
          ]),
        }),
      ],
    });

    render(<SnippetPanel />);
    expect(screen.getByText("伏線")).toBeInTheDocument();
    expect(screen.getByText("キャラ")).toBeInTheDocument();
  });

  it("shows AI source badge for ai content", () => {
    useSnippetStore.setState({
      entries: [fakeSnippet({ id: "s1", contentSource: "ai" })],
    });
    render(<SnippetPanel />);
    expect(screen.getByText("AI")).toBeInTheDocument();
  });

  it("shows Human source badge for human content", () => {
    useSnippetStore.setState({
      entries: [fakeSnippet({ id: "s1", contentSource: "human" })],
    });
    render(<SnippetPanel />);
    expect(screen.getByText("Human")).toBeInTheDocument();
  });

  it("shows char count on snippet card", () => {
    useSnippetStore.setState({
      entries: [fakeSnippet({ id: "s1", content: "Hello" })],
    });
    render(<SnippetPanel />);
    expect(screen.getByText("5 字")).toBeInTheDocument();
  });

  it("calls search when typing in search input", async () => {
    const search = vi.fn();
    useSnippetStore.setState({ search });
    const user = userEvent.setup();

    render(<SnippetPanel />);
    await user.type(screen.getByTestId("snippet-search-input"), "検索語");

    await waitFor(() => {
      expect(search).toHaveBeenCalled();
    });
  });

  it("snippet items are draggable", () => {
    useSnippetStore.setState({
      entries: [fakeSnippet({ id: "snippet-1", title: "ドラッグ可能" })],
    });

    render(<SnippetPanel />);
    const item = screen.getByTestId("snippet-item-snippet-1");
    expect(item).toHaveAttribute("draggable", "true");
  });

  it("sets dataTransfer on drag start", () => {
    useSnippetStore.setState({
      entries: [fakeSnippet({ id: "snippet-1", content: "ドラッグ内容" })],
    });

    render(<SnippetPanel />);
    const item = screen.getByTestId("snippet-item-snippet-1");

    const setData = vi.fn();
    const dragEvent = new Event("dragstart", { bubbles: true });
    Object.defineProperty(dragEvent, "dataTransfer", {
      value: { setData },
    });
    item.dispatchEvent(dragEvent);

    expect(setData).toHaveBeenCalledWith("text/plain", "ドラッグ内容");
    expect(setData).toHaveBeenCalledWith(
      "application/x-grimodex-snippet",
      JSON.stringify({
        id: "snippet-1",
        content: "ドラッグ内容",
        source: "human",
        originalContent: null,
        sourceChatMessageId: null,
      }),
    );
  });

  it("shows delete button and calls remove on click", async () => {
    const remove = vi.fn();
    useSnippetStore.setState({
      entries: [fakeSnippet({ id: "snippet-1" })],
      remove,
    });
    const user = userEvent.setup();

    render(<SnippetPanel />);
    await user.click(screen.getByTestId("snippet-delete-snippet-1"));

    // Confirmation dialog should appear
    expect(screen.getByText("削除の確認")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "削除する" }));

    expect(remove).toHaveBeenCalledWith("snippet-1");
  });

  it("shows loading state", () => {
    useSnippetStore.setState({ isLoading: true });
    render(<SnippetPanel />);
    expect(screen.getByTestId("snippet-loading")).toBeInTheDocument();
  });

  it("hides loading skeleton when entries are loaded", async () => {
    useSnippetStore.setState({ isLoading: false, entries: [fakeSnippet()] });
    render(<SnippetPanel />);
    expect(screen.queryByTestId("snippet-loading")).not.toBeInTheDocument();
  });

  it("shows context menu on right-click", async () => {
    useSnippetStore.setState({
      entries: [fakeSnippet({ id: "snippet-1" })],
    });
    const user = userEvent.setup();

    render(<SnippetPanel />);
    await user.pointer({
      target: screen.getByTestId("snippet-item-snippet-1"),
      keys: "[MouseRight]",
    });

    expect(screen.getByTestId("snippet-context-menu")).toBeInTheDocument();
  });

  it("calls copyWithAttribution on double-click", async () => {
    const { copyWithAttribution } = await import("@/lib/clipboardAttribution");
    useSnippetStore.setState({
      entries: [fakeSnippet({ id: "snippet-1", content: "コピー内容" })],
    });

    render(<SnippetPanel />);
    const item = screen.getByTestId("snippet-item-snippet-1");
    await userEvent.dblClick(item);

    expect(copyWithAttribution).toHaveBeenCalledWith("コピー内容", "human");
  });

  it("AI snippet のカードコピーボタンは source='ai' で copyWithAttribution を呼ぶ", async () => {
    const { copyWithAttribution } = await import("@/lib/clipboardAttribution");
    useSnippetStore.setState({
      entries: [
        fakeSnippet({ id: "s1", content: "AI内容", contentSource: "ai" }),
      ],
    });

    render(<SnippetPanel />);
    await userEvent.click(screen.getByTestId("snippet-copy-s1"));

    expect(copyWithAttribution).toHaveBeenCalledWith("AI内容", "ai");
  });

  it("AI snippet カードの onCopy は source='ai' を注入する", async () => {
    const { handleCopyWithAttribution } =
      await import("@/lib/clipboardAttribution");
    useSnippetStore.setState({
      entries: [fakeSnippet({ id: "s1", contentSource: "ai" })],
    });

    render(<SnippetPanel />);
    fireEvent.copy(screen.getByTestId("snippet-item-s1"));

    expect(handleCopyWithAttribution).toHaveBeenCalledWith(
      expect.anything(),
      "ai",
    );
  });

  it("navigates focused index with arrow keys", async () => {
    useSnippetStore.setState({
      entries: [
        fakeSnippet({ id: "s1", title: "最初" }),
        fakeSnippet({ id: "s2", title: "二番目" }),
      ],
    });
    const user = userEvent.setup();

    render(<SnippetPanel />);
    const panel = screen.getByTestId("snippet-panel");
    panel.focus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("snippet-item-s1").className).toContain("ring-1");

    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("snippet-item-s2").className).toContain("ring-1");
  });

  it("preserves selection across remount (layout preset switch)", () => {
    // レイアウトプリセット切替でパネルが配置から外れる（または閉じられる）
    // と subtree は unmount される。選択がストアに乗ったことで unmount →
    // 再 mount を跨いでも保持されることを回帰として固定する。
    const snippet = fakeSnippet({ id: "snippet-1" });
    useSnippetStore.setState({ entries: [snippet], selectedSnippet: snippet });

    const { unmount } = render(<SnippetPanel />);
    expect(screen.getByTestId("snippet-detail-content")).toBeInTheDocument();

    // preset 切替に相当する remount を再現
    unmount();
    render(<SnippetPanel />);

    // placeholder ではなく detail がそのまま復帰する = 選択維持
    expect(screen.getByTestId("snippet-detail-content")).toBeInTheDocument();
    expect(
      screen.queryByTestId("snippet-detail-placeholder"),
    ).not.toBeInTheDocument();
  });
});
