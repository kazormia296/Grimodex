// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EntryContextMenu } from "./EntryContextMenu";
import type { CodexEntry } from "@/features/codex/api";

const mockEntry: CodexEntry = {
  id: "entry-1",
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
  tagsCache: null,
  contextMode: "mentioned",
  childrenBudget: "compact",
  sourceChatMessageId: null,
  notes: null,
  version: 0,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const defaultProps = {
  entry: mockEntry,
  x: 100,
  y: 200,
  onClose: vi.fn(),
  onDelete: vi.fn(),
  onRename: vi.fn(),
  onDuplicate: vi.fn(),
  onFindInScenes: vi.fn(),
  codexTypes: [] as import("@/features/codex/typeApi").CodexType[],
};

describe("EntryContextMenu", () => {
  it("renders at the specified position", () => {
    render(<EntryContextMenu {...defaultProps} />);
    const menu = screen.getByTestId("entry-context-menu");
    expect(menu).toBeInTheDocument();
    // Position is applied via inline style
    expect(menu).toHaveStyle({ left: "100px", top: "200px" });
  });

  it("shows Delete menu item", () => {
    render(<EntryContextMenu {...defaultProps} />);
    expect(screen.getByTestId("entry-context-menu-delete")).toBeInTheDocument();
  });

  it("shows Rename menu item", () => {
    render(<EntryContextMenu {...defaultProps} />);
    expect(screen.getByTestId("entry-context-menu-rename")).toBeInTheDocument();
  });

  it("shows entry name in header", () => {
    render(<EntryContextMenu {...defaultProps} />);
    expect(screen.getByText("アリス")).toBeInTheDocument();
  });

  it("calls onDelete when Delete is clicked", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<EntryContextMenu {...defaultProps} onDelete={onDelete} />);
    await user.click(screen.getByTestId("entry-context-menu-delete"));
    expect(onDelete).toHaveBeenCalledWith("entry-1");
  });

  it("calls onRename when Rename is clicked", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(<EntryContextMenu {...defaultProps} onRename={onRename} />);
    await user.click(screen.getByTestId("entry-context-menu-rename"));
    expect(onRename).toHaveBeenCalledWith("entry-1");
  });

  it("calls onClose when clicking outside the menu", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <div>
        <EntryContextMenu {...defaultProps} onClose={onClose} />
        <button data-testid="outside">outside</button>
      </div>,
    );
    await user.click(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose after any action", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<EntryContextMenu {...defaultProps} onClose={onClose} />);
    await user.click(screen.getByTestId("entry-context-menu-delete"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows Duplicate menu item", () => {
    render(<EntryContextMenu {...defaultProps} />);
    expect(
      screen.getByTestId("entry-context-menu-duplicate"),
    ).toBeInTheDocument();
  });

  it("calls onDuplicate when Duplicate is clicked", async () => {
    const user = userEvent.setup();
    const onDuplicate = vi.fn();
    render(<EntryContextMenu {...defaultProps} onDuplicate={onDuplicate} />);
    await user.click(screen.getByTestId("entry-context-menu-duplicate"));
    expect(onDuplicate).toHaveBeenCalledWith("entry-1");
  });

  it("shows Find in scenes menu item", () => {
    render(<EntryContextMenu {...defaultProps} />);
    expect(
      screen.getByTestId("entry-context-menu-find-in-scenes"),
    ).toBeInTheDocument();
  });

  it("calls onFindInScenes when Find in scenes is clicked", async () => {
    const user = userEvent.setup();
    const onFindInScenes = vi.fn();
    render(
      <EntryContextMenu {...defaultProps} onFindInScenes={onFindInScenes} />,
    );
    await user.click(screen.getByTestId("entry-context-menu-find-in-scenes"));
    expect(onFindInScenes).toHaveBeenCalledWith("entry-1");
  });

  it("shows Change type menu item", () => {
    render(<EntryContextMenu {...defaultProps} />);
    expect(
      screen.getByTestId("entry-context-menu-change-type"),
    ).toBeInTheDocument();
  });
});
