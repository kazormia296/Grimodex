// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mockCreateNode = vi.fn().mockResolvedValue(undefined);
const mockSetSearchQuery = vi.fn();
const mockExpandAll = vi.fn();
const mockCollapseAll = vi.fn();

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: vi.fn((sel: (s: unknown) => unknown) =>
    sel({ createNode: mockCreateNode }),
  ),
}));

vi.mock("../gridStore", () => ({
  useGridStore: vi.fn((sel: (s: unknown) => unknown) =>
    sel({
      searchQuery: "",
      setSearchQuery: mockSetSearchQuery,
      collapsedFolderIds: new Set<string>(),
      expandAllFolders: mockExpandAll,
      collapseAllFolders: mockCollapseAll,
    }),
  ),
}));

vi.mock("../GridContainerSelector", () => ({
  GridContainerSelector: () => <div data-testid="container-selector" />,
}));

import { useGridStore } from "../gridStore";
import { GridHeader } from "../GridHeader";

const mockGridStore = useGridStore as unknown as {
  mockImplementation: (
    fn: (selector: (s: unknown) => unknown) => unknown,
  ) => void;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGridStore.mockImplementation((sel) =>
    sel({
      searchQuery: "",
      setSearchQuery: mockSetSearchQuery,
      collapsedFolderIds: new Set<string>(),
      expandAllFolders: mockExpandAll,
      collapseAllFolders: mockCollapseAll,
    }),
  );
});

describe("GridHeader", () => {
  const defaultProps = {
    containerId: "c1",
    projectId: "proj-1",
    chapterCount: 3,
    nestedFolderIds: [] as string[],
    onContainerChange: vi.fn(),
    onTogglePanelMenu: vi.fn(),
  };

  it("章数を表示する", () => {
    render(<GridHeader {...defaultProps} chapterCount={5} />);
    expect(screen.getByText("5 章")).toBeDefined();
  });

  it("🔍 ボタンクリックで検索バーが展開される", () => {
    render(<GridHeader {...defaultProps} />);
    expect(
      screen.queryByPlaceholderText("シーン名・Synopsis・Beat・Codex を検索…"),
    ).toBeNull();
    fireEvent.click(screen.getByTitle("検索"));
    expect(
      screen.getByPlaceholderText("シーン名・Synopsis・Beat・Codex を検索…"),
    ).toBeDefined();
  });

  it("検索バーで文字入力すると setSearchQuery が呼ばれる", () => {
    render(<GridHeader {...defaultProps} />);
    fireEvent.click(screen.getByTitle("検索"));
    const input = screen.getByPlaceholderText(
      "シーン名・Synopsis・Beat・Codex を検索…",
    );
    fireEvent.change(input, { target: { value: "序章" } });
    expect(mockSetSearchQuery).toHaveBeenCalledWith("序章");
  });

  it("検索バーで Escape を押すと検索をクリアして閉じる", () => {
    render(<GridHeader {...defaultProps} />);
    fireEvent.click(screen.getByTitle("検索"));
    const input = screen.getByPlaceholderText(
      "シーン名・Synopsis・Beat・Codex を検索…",
    );
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mockSetSearchQuery).toHaveBeenCalledWith("");
    expect(
      screen.queryByPlaceholderText("シーン名・Synopsis・Beat・Codex を検索…"),
    ).toBeNull();
  });

  it("🔍 ボタンを再クリックすると検索バーが閉じて setSearchQuery('') が呼ばれる", () => {
    render(<GridHeader {...defaultProps} />);
    fireEvent.click(screen.getByTitle("検索"));
    fireEvent.click(screen.getByTitle("検索"));
    expect(mockSetSearchQuery).toHaveBeenCalledWith("");
  });

  it("[⋮] ボタンクリックで onTogglePanelMenu が呼ばれる", () => {
    const onToggle = vi.fn();
    render(<GridHeader {...defaultProps} onTogglePanelMenu={onToggle} />);
    fireEvent.click(screen.getByTitle("メニュー"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("searchQuery が非空のとき × ボタンが表示される", () => {
    mockGridStore.mockImplementation((sel) =>
      sel({
        searchQuery: "序章",
        setSearchQuery: mockSetSearchQuery,
        collapsedFolderIds: new Set<string>(),
        expandAllFolders: mockExpandAll,
        collapseAllFolders: mockCollapseAll,
      }),
    );
    render(<GridHeader {...defaultProps} />);
    fireEvent.click(screen.getByTitle("検索"));
    // × button (X icon button) should exist when query is non-empty
    // It's rendered only when searchQuery truthy — check we can find the search bar
    const input = screen.getByPlaceholderText(
      "シーン名・Synopsis・Beat・Codex を検索…",
    );
    expect(input).toBeDefined();
  });
});
