// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { SnippetPanel } from "./SnippetPanel";
import { useSnippetStore } from "./snippetStore";
import type { Snippet } from "./api";

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
    loadEntries: vi.fn(),
    search: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    incrementUsageCount: vi.fn(),
    setSourceFilter: vi.fn(),
    setSortOrder: vi.fn(),
  }));
  return { useSnippetStore: store };
});

const fakeSnippet = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: "snippet-1",
  projectId: "default-project",
  title: "テストスニペット",
  content: "スニペット内容",
  tags: "タグ1,タグ2",
  tagsCache: null,
  sceneId: null,
  sourceChatMessageId: null,
  usageCount: 0,
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
    });
  });

  it("renders the panel with search input", () => {
    render(<SnippetPanel />);
    expect(screen.getByTestId("snippet-search-input")).toBeInTheDocument();
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

  it("calls loadEntries on mount", () => {
    const loadEntries = vi.fn();
    useSnippetStore.setState({ loadEntries });
    render(<SnippetPanel />);
    expect(loadEntries).toHaveBeenCalled();
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
      entries: [fakeSnippet({ id: "snippet-1", tags: "伏線,キャラ" })],
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
    expect(screen.getByText("5 chars")).toBeInTheDocument();
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
});
