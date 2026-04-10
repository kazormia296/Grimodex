// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SnippetContextMenu } from "./SnippetContextMenu";
import type { Snippet } from "./api";

vi.mock("./snippetStore", () => ({
  useSnippetStore: (selector: (s: unknown) => unknown) =>
    selector({
      create: vi.fn().mockResolvedValue({}),
      incrementUsageCount: vi.fn(),
    }),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (selector: (s: unknown) => unknown) =>
    selector({ setActiveScene: vi.fn() }),
}));

vi.mock("@/features/editor/editorStore", () => {
  const mockInsert = vi.fn(() => true);
  const mockStore = (selector: (s: unknown) => unknown) =>
    selector({ insertFromSnippet: mockInsert });
  mockStore.getState = () => ({ insertFromSnippet: mockInsert });
  return { useEditorStore: mockStore };
});

vi.mock("@/lib/clipboardAttribution", () => ({
  copyWithAttribution: vi.fn(),
}));

const fakeSnippet = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: "s1",
  projectId: "p1",
  title: "テスト",
  content: "内容",
  tags: null,
  sceneId: null,
  sourceChatMessageId: null,
  usageCount: 0,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  ...overrides,
});

describe("SnippetContextMenu", () => {
  const baseProps = {
    x: 100,
    y: 100,
    onClose: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders menu items", () => {
    render(<SnippetContextMenu snippet={fakeSnippet()} {...baseProps} />);
    expect(screen.getByTestId("snippet-context-insert")).toBeInTheDocument();
    expect(screen.getByTestId("snippet-context-copy")).toBeInTheDocument();
    expect(screen.getByTestId("snippet-context-edit")).toBeInTheDocument();
    expect(screen.getByTestId("snippet-context-duplicate")).toBeInTheDocument();
    expect(screen.getByTestId("snippet-context-delete")).toBeInTheDocument();
  });

  it("does not show go-to-scene when sceneId is null", () => {
    render(<SnippetContextMenu snippet={fakeSnippet()} {...baseProps} />);
    expect(
      screen.queryByTestId("snippet-context-go-to-scene"),
    ).not.toBeInTheDocument();
  });

  it("shows go-to-scene when sceneId is present", () => {
    render(
      <SnippetContextMenu
        snippet={fakeSnippet({ sceneId: "scene-1" })}
        {...baseProps}
      />,
    );
    expect(
      screen.getByTestId("snippet-context-go-to-scene"),
    ).toBeInTheDocument();
  });

  it("calls onEdit and onClose when Edit is clicked", async () => {
    const onEdit = vi.fn();
    const onClose = vi.fn();
    const snippet = fakeSnippet();
    const user = userEvent.setup();

    render(
      <SnippetContextMenu
        snippet={snippet}
        {...baseProps}
        onEdit={onEdit}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByTestId("snippet-context-edit"));
    expect(onEdit).toHaveBeenCalledWith(snippet);
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onDelete and onClose when Delete is clicked", async () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <SnippetContextMenu
        snippet={fakeSnippet()}
        {...baseProps}
        onDelete={onDelete}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByTestId("snippet-context-delete"));
    expect(onDelete).toHaveBeenCalledWith("s1");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape key", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <SnippetContextMenu
        snippet={fakeSnippet()}
        {...baseProps}
        onClose={onClose}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on outside click", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <div>
        <SnippetContextMenu
          snippet={fakeSnippet()}
          {...baseProps}
          onClose={onClose}
        />
        <button type="button" data-testid="outside">
          outside
        </button>
      </div>,
    );
    await user.click(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalled();
  });
});
