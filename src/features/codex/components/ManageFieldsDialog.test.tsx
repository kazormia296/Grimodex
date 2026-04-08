// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ManageFieldsDialog } from "./ManageFieldsDialog";
import type { CodexDetailDefinition } from "@/features/codex/detailApi";

const makeDefinition = (
  id: string,
  name: string,
  fieldType = "text",
  overrides?: Partial<CodexDetailDefinition>,
): CodexDetailDefinition => ({
  id,
  projectId: "proj-1",
  typeSlug: "character",
  name,
  fieldType,
  fieldConfig: null,
  sortOrder: 0.0,
  includeInContext: 0,
  createdAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

vi.mock("@/features/codex/detailApi", () => ({
  listDefinitionsByType: vi.fn(),
  createDefinition: vi.fn(),
  updateDefinition: vi.fn(),
  deleteDefinition: vi.fn(),
}));

import {
  listDefinitionsByType,
  createDefinition,
  updateDefinition,
  deleteDefinition,
} from "@/features/codex/detailApi";

const mockListDefs = vi.mocked(listDefinitionsByType);
const mockCreate = vi.mocked(createDefinition);
const mockUpdate = vi.mocked(updateDefinition);
const mockDelete = vi.mocked(deleteDefinition);

const defaultProps = {
  projectId: "proj-1",
  typeSlug: "character",
  typeLabel: "キャラクター",
  open: true,
  onClose: vi.fn(),
};

describe("ManageFieldsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDefs.mockResolvedValue([]);
    mockCreate.mockResolvedValue(makeDefinition("new-def", "新フィールド"));
    mockUpdate.mockResolvedValue(makeDefinition("def-1", "更新名"));
    mockDelete.mockResolvedValue(undefined);
  });

  it("does not render dialog when open=false", () => {
    render(<ManageFieldsDialog {...defaultProps} open={false} />);
    expect(
      screen.queryByTestId("manage-fields-dialog"),
    ).not.toBeInTheDocument();
  });

  it("renders dialog with title when open=true", async () => {
    render(<ManageFieldsDialog {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("manage-fields-dialog")).toBeInTheDocument();
      expect(screen.getByText(/キャラクター/)).toBeInTheDocument();
    });
  });

  it("renders definition list", async () => {
    mockListDefs.mockResolvedValue([
      makeDefinition("def-1", "身長", "text"),
      makeDefinition("def-2", "種族", "dropdown"),
    ]);
    render(<ManageFieldsDialog {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("manage-field-row-def-1")).toBeInTheDocument();
      expect(screen.getByTestId("manage-field-row-def-2")).toBeInTheDocument();
      expect(screen.getByText("身長")).toBeInTheDocument();
      expect(screen.getByText("種族")).toBeInTheDocument();
    });
  });

  it("shows field type badge in list", async () => {
    mockListDefs.mockResolvedValue([makeDefinition("def-1", "身長", "text")]);
    render(<ManageFieldsDialog {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("manage-field-type-def-1")).toHaveTextContent(
        "text",
      );
    });
  });

  it("calls onClose when Close button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ManageFieldsDialog {...defaultProps} onClose={onClose} />);
    await waitFor(() => screen.getByTestId("manage-fields-close-button"));
    await user.click(screen.getByTestId("manage-fields-close-button"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows add form when [+ Add field] is clicked", async () => {
    const user = userEvent.setup();
    render(<ManageFieldsDialog {...defaultProps} />);
    await waitFor(() => screen.getByTestId("manage-fields-add-button"));
    await user.click(screen.getByTestId("manage-fields-add-button"));
    expect(screen.getByTestId("manage-field-add-form")).toBeInTheDocument();
  });

  it("creates a definition when add form is submitted", async () => {
    const user = userEvent.setup();
    render(<ManageFieldsDialog {...defaultProps} />);
    await waitFor(() => screen.getByTestId("manage-fields-add-button"));
    await user.click(screen.getByTestId("manage-fields-add-button"));

    await user.clear(screen.getByTestId("manage-field-name-input"));
    await user.type(
      screen.getByTestId("manage-field-name-input"),
      "新フィールド",
    );
    await user.click(screen.getByTestId("manage-field-save-button"));

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "新フィールド",
        typeSlug: "character",
        projectId: "proj-1",
      }),
    );
  });

  it("cancels add form without saving", async () => {
    const user = userEvent.setup();
    render(<ManageFieldsDialog {...defaultProps} />);
    await waitFor(() => screen.getByTestId("manage-fields-add-button"));
    await user.click(screen.getByTestId("manage-fields-add-button"));

    await user.click(screen.getByTestId("manage-field-cancel-button"));
    expect(
      screen.queryByTestId("manage-field-add-form"),
    ).not.toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("shows inline edit form when edit button is clicked", async () => {
    const user = userEvent.setup();
    mockListDefs.mockResolvedValue([makeDefinition("def-1", "身長", "text")]);
    render(<ManageFieldsDialog {...defaultProps} />);
    await waitFor(() => screen.getByTestId("manage-field-edit-def-1"));
    await user.click(screen.getByTestId("manage-field-edit-def-1"));
    expect(
      screen.getByTestId("manage-field-edit-form-def-1"),
    ).toBeInTheDocument();
  });

  it("calls updateDefinition when edit form is saved", async () => {
    const user = userEvent.setup();
    mockListDefs.mockResolvedValue([makeDefinition("def-1", "身長", "text")]);
    render(<ManageFieldsDialog {...defaultProps} />);
    await waitFor(() => screen.getByTestId("manage-field-edit-def-1"));
    await user.click(screen.getByTestId("manage-field-edit-def-1"));

    const nameInput = screen.getByTestId("manage-field-edit-name-def-1");
    await user.clear(nameInput);
    await user.type(nameInput, "更新名");
    await user.click(screen.getByTestId("manage-field-edit-save-def-1"));

    expect(mockUpdate).toHaveBeenCalledWith(
      "def-1",
      expect.objectContaining({ name: "更新名" }),
    );
  });

  it("shows delete confirmation dialog when delete button is clicked", async () => {
    const user = userEvent.setup();
    mockListDefs.mockResolvedValue([makeDefinition("def-1", "身長", "text")]);
    render(<ManageFieldsDialog {...defaultProps} />);
    await waitFor(() => screen.getByTestId("manage-field-delete-def-1"));
    await user.click(screen.getByTestId("manage-field-delete-def-1"));
    expect(
      screen.getByTestId("manage-field-delete-confirm-dialog"),
    ).toBeInTheDocument();
  });

  it("calls deleteDefinition after confirming delete", async () => {
    const user = userEvent.setup();
    mockListDefs.mockResolvedValue([makeDefinition("def-1", "身長", "text")]);
    render(<ManageFieldsDialog {...defaultProps} />);
    await waitFor(() => screen.getByTestId("manage-field-delete-def-1"));
    await user.click(screen.getByTestId("manage-field-delete-def-1"));
    await user.click(screen.getByTestId("manage-field-delete-confirm-button"));
    expect(mockDelete).toHaveBeenCalledWith("def-1");
  });

  it("does not call deleteDefinition when delete is cancelled", async () => {
    const user = userEvent.setup();
    mockListDefs.mockResolvedValue([makeDefinition("def-1", "身長", "text")]);
    render(<ManageFieldsDialog {...defaultProps} />);
    await waitFor(() => screen.getByTestId("manage-field-delete-def-1"));
    await user.click(screen.getByTestId("manage-field-delete-def-1"));
    await user.click(screen.getByTestId("manage-field-delete-cancel-button"));
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
