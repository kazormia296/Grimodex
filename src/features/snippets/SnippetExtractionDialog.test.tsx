import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SnippetExtractionDialog } from "./SnippetExtractionDialog";

describe("SnippetExtractionDialog", () => {
  const defaultProps = {
    open: true,
    initialContent: "選択されたテキスト",
    messageId: "msg-1",
    onSave: vi.fn(() => Promise.resolve()),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the dialog when open is true", () => {
    render(<SnippetExtractionDialog {...defaultProps} />);
    expect(screen.getByTestId("snippet-extraction-dialog")).toBeInTheDocument();
  });

  it("does not render when open is false", () => {
    render(<SnippetExtractionDialog {...defaultProps} open={false} />);
    expect(
      screen.queryByTestId("snippet-extraction-dialog"),
    ).not.toBeInTheDocument();
  });

  it("initializes content textarea with initialContent", () => {
    render(<SnippetExtractionDialog {...defaultProps} />);
    const textarea = screen.getByTestId("snippet-content-input");
    expect(textarea).toHaveValue("選択されたテキスト");
  });

  it("allows editing title, content, and tags", async () => {
    const user = userEvent.setup();
    render(<SnippetExtractionDialog {...defaultProps} />);

    const titleInput = screen.getByTestId("snippet-title-input");
    const contentInput = screen.getByTestId("snippet-content-input");
    const tagsInput = screen.getByTestId("snippet-tags-input");

    await user.type(titleInput, "新しいタイトル");
    await user.clear(contentInput);
    await user.type(contentInput, "編集された内容");
    await user.type(tagsInput, "タグ1,タグ2");

    expect(titleInput).toHaveValue("新しいタイトル");
    expect(contentInput).toHaveValue("編集された内容");
    expect(tagsInput).toHaveValue("タグ1,タグ2");
  });

  it("calls onSave with form data when save button is clicked", async () => {
    const user = userEvent.setup();
    render(<SnippetExtractionDialog {...defaultProps} />);

    await user.type(screen.getByTestId("snippet-title-input"), "タイトル");
    await user.type(screen.getByTestId("snippet-tags-input"), "タグ");
    await user.click(screen.getByTestId("snippet-save-button"));

    await waitFor(() => {
      expect(defaultProps.onSave).toHaveBeenCalledWith({
        title: "タイトル",
        content: "選択されたテキスト",
        tags: "タグ",
        sourceChatMessageId: "msg-1",
      });
    });
  });

  it("disables save button when title is empty", () => {
    render(<SnippetExtractionDialog {...defaultProps} />);
    const saveBtn = screen.getByTestId("snippet-save-button");
    expect(saveBtn).toBeDisabled();
  });

  it("calls onClose when cancel button is clicked", async () => {
    const user = userEvent.setup();
    render(<SnippetExtractionDialog {...defaultProps} />);

    await user.click(screen.getByTestId("snippet-cancel-button"));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("calls onClose after successful save", async () => {
    const user = userEvent.setup();
    render(<SnippetExtractionDialog {...defaultProps} />);

    await user.type(screen.getByTestId("snippet-title-input"), "タイトル");
    await user.click(screen.getByTestId("snippet-save-button"));

    await waitFor(() => {
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  it("resets form when reopened with new content", async () => {
    const { rerender } = render(<SnippetExtractionDialog {...defaultProps} />);

    rerender(<SnippetExtractionDialog {...defaultProps} open={false} />);
    rerender(
      <SnippetExtractionDialog
        {...defaultProps}
        open={true}
        initialContent="新しい内容"
        messageId="msg-2"
      />,
    );

    expect(screen.getByTestId("snippet-content-input")).toHaveValue(
      "新しい内容",
    );
  });
});
