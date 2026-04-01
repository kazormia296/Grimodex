import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SnippetPanel } from "./SnippetPanel";
import { useSnippetStore } from "./snippetStore";
import type { Snippet } from "./api";

vi.mock("./snippetStore", async () => {
  const { create } = await import("zustand");
  const store = create(() => ({
    entries: [] as Snippet[],
    searchQuery: "",
    isLoading: false,
    loadEntries: vi.fn(),
    search: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }));
  return { useSnippetStore: store };
});

const fakeSnippet = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: 1,
  title: "テストスニペット",
  content: "スニペット内容",
  tags: "タグ1,タグ2",
  sceneId: null,
  sourceChatMessageId: null,
  source: "human",
  originalContent: null,
  createdAt: "2025-01-01T00:00:00Z",
  ...overrides,
});

describe("SnippetPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSnippetStore.setState({
      entries: [],
      searchQuery: "",
      isLoading: false,
    });
  });

  it("renders the panel with search input", () => {
    render(<SnippetPanel />);
    expect(screen.getByTestId("snippet-search-input")).toBeInTheDocument();
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
        fakeSnippet({ id: 1, title: "一つ目" }),
        fakeSnippet({ id: 2, title: "二つ目" }),
      ],
    });

    render(<SnippetPanel />);
    expect(screen.getByText("一つ目")).toBeInTheDocument();
    expect(screen.getByText("二つ目")).toBeInTheDocument();
  });

  it("displays tags on snippet items", () => {
    useSnippetStore.setState({
      entries: [fakeSnippet({ id: 1, tags: "伏線,キャラ" })],
    });

    render(<SnippetPanel />);
    expect(screen.getByText("伏線")).toBeInTheDocument();
    expect(screen.getByText("キャラ")).toBeInTheDocument();
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
      entries: [fakeSnippet({ id: 1, title: "ドラッグ可能" })],
    });

    render(<SnippetPanel />);
    const item = screen.getByTestId("snippet-item-1");
    expect(item).toHaveAttribute("draggable", "true");
  });

  it("sets dataTransfer on drag start", () => {
    useSnippetStore.setState({
      entries: [fakeSnippet({ id: 1, content: "ドラッグ内容" })],
    });

    render(<SnippetPanel />);
    const item = screen.getByTestId("snippet-item-1");

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
        id: 1,
        content: "ドラッグ内容",
        source: "human",
        originalContent: null,
      }),
    );
  });

  it("shows delete button and calls remove on click", async () => {
    const remove = vi.fn();
    useSnippetStore.setState({
      entries: [fakeSnippet({ id: 1 })],
      remove,
    });
    const user = userEvent.setup();

    render(<SnippetPanel />);
    await user.click(screen.getByTestId("snippet-delete-1"));

    expect(remove).toHaveBeenCalledWith(1);
  });

  it("shows loading state", () => {
    useSnippetStore.setState({ isLoading: true });
    render(<SnippetPanel />);
    expect(screen.getByTestId("snippet-loading")).toBeInTheDocument();
  });
});
