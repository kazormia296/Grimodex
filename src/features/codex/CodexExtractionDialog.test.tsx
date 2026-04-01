import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodexExtractionDialog } from "./CodexExtractionDialog";

describe("CodexExtractionDialog", () => {
  const defaultProps = {
    open: true,
    messageId: "msg-1",
    initialContent: "抽出対象テキスト",
    onSave: vi.fn(),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not render when open is false", () => {
    render(<CodexExtractionDialog {...defaultProps} open={false} />);
    expect(
      screen.queryByTestId("codex-extraction-dialog"),
    ).not.toBeInTheDocument();
  });

  it("renders the dialog with form fields when open", () => {
    render(<CodexExtractionDialog {...defaultProps} />);

    expect(screen.getByTestId("codex-extraction-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("codex-type-select")).toBeInTheDocument();
    expect(screen.getByTestId("codex-name-input")).toBeInTheDocument();
    expect(screen.getByTestId("codex-summary-textarea")).toBeInTheDocument();
    expect(screen.getByTestId("codex-tags-input")).toBeInTheDocument();
    expect(screen.getByTestId("codex-save-button")).toBeInTheDocument();
    expect(screen.getByTestId("codex-cancel-button")).toBeInTheDocument();
  });

  it("initializes summary textarea with initialContent", () => {
    render(<CodexExtractionDialog {...defaultProps} />);

    const textarea = screen.getByTestId(
      "codex-summary-textarea",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("抽出対象テキスト");
  });

  it("allows editing all form fields", async () => {
    const user = userEvent.setup();
    render(<CodexExtractionDialog {...defaultProps} />);

    // Type select
    const typeSelect = screen.getByTestId(
      "codex-type-select",
    ) as HTMLSelectElement;
    await user.selectOptions(typeSelect, "location");
    expect(typeSelect.value).toBe("location");

    // Name input
    const nameInput = screen.getByTestId("codex-name-input");
    await user.type(nameInput, "テスト名前");
    expect(nameInput).toHaveValue("テスト名前");

    // Summary textarea - clear and retype
    const summaryTextarea = screen.getByTestId("codex-summary-textarea");
    await user.clear(summaryTextarea);
    await user.type(summaryTextarea, "編集済みテキスト");
    expect(summaryTextarea).toHaveValue("編集済みテキスト");

    // Tags input
    const tagsInput = screen.getByTestId("codex-tags-input");
    await user.type(tagsInput, "タグ1,タグ2");
    expect(tagsInput).toHaveValue("タグ1,タグ2");
  });

  it("calls onSave with form data when save button is clicked", async () => {
    const user = userEvent.setup();
    render(<CodexExtractionDialog {...defaultProps} />);

    await user.selectOptions(
      screen.getByTestId("codex-type-select"),
      "character",
    );
    await user.type(screen.getByTestId("codex-name-input"), "アリス");
    await user.type(screen.getByTestId("codex-tags-input"), "主人公");
    await user.click(screen.getByTestId("codex-save-button"));

    await waitFor(() => {
      expect(defaultProps.onSave).toHaveBeenCalledWith({
        type: "character",
        name: "アリス",
        summary: "抽出対象テキスト",
        tags: "主人公",
        sourceChatMessageId: "msg-1",
      });
    });
  });

  it("does not call onSave when name is empty", async () => {
    const user = userEvent.setup();
    render(<CodexExtractionDialog {...defaultProps} />);

    // Don't fill in name, just click save
    await user.click(screen.getByTestId("codex-save-button"));

    expect(defaultProps.onSave).not.toHaveBeenCalled();
  });

  it("calls onClose when cancel button is clicked", async () => {
    const user = userEvent.setup();
    render(<CodexExtractionDialog {...defaultProps} />);

    await user.click(screen.getByTestId("codex-cancel-button"));

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("resets form when opened with new content", () => {
    const { rerender } = render(
      <CodexExtractionDialog {...defaultProps} open={false} />,
    );

    rerender(
      <CodexExtractionDialog
        {...defaultProps}
        open={true}
        initialContent="新しいテキスト"
      />,
    );

    const textarea = screen.getByTestId(
      "codex-summary-textarea",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("新しいテキスト");
  });
});
