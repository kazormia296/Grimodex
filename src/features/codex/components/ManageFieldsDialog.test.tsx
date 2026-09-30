// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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
  version: 0,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

vi.mock("@/features/codex/detailApi", () => ({
  listDefinitionsByType: vi.fn(),
  createDefinition: vi.fn(),
  updateDefinition: vi.fn(),
  deleteDefinition: vi.fn(),
}));

vi.mock("@/features/codex/detailPresets", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/codex/detailPresets")>();
  return { ...actual, applyDetailPreset: vi.fn() };
});

vi.mock("@/features/codex/detailCleanup", () => ({
  listEmptyDetailFields: vi.fn(),
  deleteEmptyDetailFields: vi.fn(),
}));

import {
  listDefinitionsByType,
  createDefinition,
  updateDefinition,
  deleteDefinition,
} from "@/features/codex/detailApi";
import {
  applyDetailPreset,
  resolvePresetFields,
} from "@/features/codex/detailPresets";
import {
  listEmptyDetailFields,
  deleteEmptyDetailFields,
} from "@/features/codex/detailCleanup";

const mockListDefs = vi.mocked(listDefinitionsByType);
const mockCreate = vi.mocked(createDefinition);
const mockUpdate = vi.mocked(updateDefinition);
const mockDelete = vi.mocked(deleteDefinition);
const mockApplyPreset = vi.mocked(applyDetailPreset);
const mockListEmpty = vi.mocked(listEmptyDetailFields);
const mockDeleteEmpty = vi.mocked(deleteEmptyDetailFields);

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
    mockApplyPreset.mockResolvedValue({ added: [], skipped: 0 });
    mockListEmpty.mockResolvedValue([]);
    mockDeleteEmpty.mockResolvedValue({ deleted: [], kept: 0 });
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
      { baseVersion: 0 },
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

  it("stacks the delete confirmation above the portaled dialog", async () => {
    // AnimatedOverlay は body へ portal される (z-50)。確認ダイアログが
    // インライン z-50 のままだと DOM 順で負けて裏に隠れる regression を gate。
    const user = userEvent.setup();
    mockListDefs.mockResolvedValue([makeDefinition("def-1", "身長", "text")]);
    render(<ManageFieldsDialog {...defaultProps} />);
    await waitFor(() => screen.getByTestId("manage-field-delete-def-1"));
    await user.click(screen.getByTestId("manage-field-delete-def-1"));

    const confirm = screen.getByTestId("manage-field-delete-confirm-dialog");
    const backdrop = screen.getByTestId("animated-overlay-backdrop");
    expect(confirm.parentElement).toBe(document.body);
    const bodyChildren = Array.from(document.body.children);
    expect(bodyChildren.indexOf(confirm)).toBeGreaterThan(
      bodyChildren.indexOf(backdrop),
    );
    expect(confirm.className).toContain("z-[60]");
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

  it("Escape closes only the delete confirmation, not the parent dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockListDefs.mockResolvedValue([makeDefinition("def-1", "身長", "text")]);
    render(<ManageFieldsDialog {...defaultProps} onClose={onClose} />);
    await waitFor(() => screen.getByTestId("manage-field-delete-def-1"));
    await user.click(screen.getByTestId("manage-field-delete-def-1"));
    expect(
      screen.getByTestId("manage-field-delete-confirm-dialog"),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(
      screen.queryByTestId("manage-field-delete-confirm-dialog"),
    ).not.toBeInTheDocument();
    // 親 (AnimatedOverlay) の Escape close は capture で先取りされている
    expect(onClose).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("delete confirmation has dialog semantics and backdrop click closes it", async () => {
    const user = userEvent.setup();
    mockListDefs.mockResolvedValue([makeDefinition("def-1", "身長", "text")]);
    render(<ManageFieldsDialog {...defaultProps} />);
    await waitFor(() => screen.getByTestId("manage-field-delete-def-1"));
    await user.click(screen.getByTestId("manage-field-delete-def-1"));

    const backdrop = screen.getByTestId("manage-field-delete-confirm-dialog");
    const dialog = backdrop.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName();

    // ダイアログ内クリックでは閉じない
    fireEvent.click(dialog as HTMLElement);
    expect(
      screen.getByTestId("manage-field-delete-confirm-dialog"),
    ).toBeInTheDocument();

    // backdrop 直クリックで閉じる
    fireEvent.click(backdrop);
    expect(
      screen.queryByTestId("manage-field-delete-confirm-dialog"),
    ).not.toBeInTheDocument();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  describe("dropdown options editing", () => {
    const openAddForm = async (user: ReturnType<typeof userEvent.setup>) => {
      await waitFor(() => screen.getByTestId("manage-fields-add-button"));
      await user.click(screen.getByTestId("manage-fields-add-button"));
    };

    it("shows the options textarea only for the dropdown type", async () => {
      const user = userEvent.setup();
      render(<ManageFieldsDialog {...defaultProps} />);
      await openAddForm(user);

      expect(
        screen.queryByTestId("manage-field-options-input"),
      ).not.toBeInTheDocument();

      await user.selectOptions(
        screen.getByTestId("manage-field-type-select"),
        "dropdown",
      );
      expect(
        screen.getByTestId("manage-field-options-input"),
      ).toBeInTheDocument();
    });

    it("creates a dropdown definition with trimmed deduped options", async () => {
      const user = userEvent.setup();
      render(<ManageFieldsDialog {...defaultProps} />);
      await openAddForm(user);

      await user.type(screen.getByTestId("manage-field-name-input"), "役職");
      await user.selectOptions(
        screen.getByTestId("manage-field-type-select"),
        "dropdown",
      );
      fireEvent.change(screen.getByTestId("manage-field-options-input"), {
        target: { value: " 主役 \n脇役\n\n主役" },
      });
      await user.click(screen.getByTestId("manage-field-save-button"));

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const data = mockCreate.mock.calls[0][0];
      expect(data.fieldType).toBe("dropdown");
      expect(JSON.parse(data.fieldConfig as string)).toEqual({
        options: ["主役", "脇役"],
      });
    });

    it("does not save a dropdown without any options", async () => {
      const user = userEvent.setup();
      render(<ManageFieldsDialog {...defaultProps} />);
      await openAddForm(user);

      await user.type(screen.getByTestId("manage-field-name-input"), "役職");
      await user.selectOptions(
        screen.getByTestId("manage-field-type-select"),
        "dropdown",
      );
      await user.click(screen.getByTestId("manage-field-save-button"));

      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("keeps fieldConfig null for text fields", async () => {
      const user = userEvent.setup();
      render(<ManageFieldsDialog {...defaultProps} />);
      await openAddForm(user);

      await user.type(screen.getByTestId("manage-field-name-input"), "身長");
      await user.click(screen.getByTestId("manage-field-save-button"));

      const data = mockCreate.mock.calls[0][0];
      expect(data.fieldConfig ?? null).toBeNull();
    });

    it("prefills existing options in the edit form", async () => {
      const user = userEvent.setup();
      mockListDefs.mockResolvedValue([
        makeDefinition("def-1", "役職", "dropdown", {
          fieldConfig: JSON.stringify({ options: ["主役", "脇役"] }),
        }),
      ]);
      render(<ManageFieldsDialog {...defaultProps} />);
      await waitFor(() => screen.getByTestId("manage-field-edit-def-1"));
      await user.click(screen.getByTestId("manage-field-edit-def-1"));

      const textarea = screen.getByTestId(
        "manage-field-edit-options-def-1",
      ) as HTMLTextAreaElement;
      expect(textarea.value).toBe("主役\n脇役");
    });

    it("saves edited options as fieldConfig JSON", async () => {
      const user = userEvent.setup();
      mockListDefs.mockResolvedValue([
        makeDefinition("def-1", "役職", "dropdown", {
          fieldConfig: JSON.stringify({ options: ["主役"] }),
        }),
      ]);
      render(<ManageFieldsDialog {...defaultProps} />);
      await waitFor(() => screen.getByTestId("manage-field-edit-def-1"));
      await user.click(screen.getByTestId("manage-field-edit-def-1"));

      fireEvent.change(screen.getByTestId("manage-field-edit-options-def-1"), {
        target: { value: "主役\n敵役" },
      });
      await user.click(screen.getByTestId("manage-field-edit-save-def-1"));

      expect(mockUpdate).toHaveBeenCalledWith(
        "def-1",
        expect.objectContaining({
          fieldConfig: JSON.stringify({ options: ["主役", "敵役"] }),
        }),
        { baseVersion: 0 },
      );
    });

    it("clears fieldConfig when the type changes away from dropdown", async () => {
      const user = userEvent.setup();
      mockListDefs.mockResolvedValue([
        makeDefinition("def-1", "役職", "dropdown", {
          fieldConfig: JSON.stringify({ options: ["主役"] }),
        }),
      ]);
      render(<ManageFieldsDialog {...defaultProps} />);
      await waitFor(() => screen.getByTestId("manage-field-edit-def-1"));
      await user.click(screen.getByTestId("manage-field-edit-def-1"));

      await user.selectOptions(
        screen.getByTestId("manage-field-edit-type-def-1"),
        "text",
      );
      await user.click(screen.getByTestId("manage-field-edit-save-def-1"));

      expect(mockUpdate).toHaveBeenCalledWith(
        "def-1",
        expect.objectContaining({ fieldType: "text", fieldConfig: null }),
        { baseVersion: 0 },
      );
    });
  });

  describe("preset picker", () => {
    const getPresetSelect = () =>
      screen.getByTestId("manage-fields-preset-select") as HTMLSelectElement;

    it("renders a preset select with base option and preset genres", async () => {
      render(<ManageFieldsDialog {...defaultProps} />);
      await waitFor(() => getPresetSelect());
      const values = Array.from(getPresetSelect().options).map((o) => o.value);
      expect(values[0]).toBe("");
      expect(values).toContain("Fantasy");
    });

    it("defaults the selection to the project genre", async () => {
      render(<ManageFieldsDialog {...defaultProps} projectGenre="Mystery" />);
      await waitFor(() => getPresetSelect());
      expect(getPresetSelect().value).toBe("Mystery");
    });

    it("falls back to the base set when the project genre has no preset", async () => {
      render(<ManageFieldsDialog {...defaultProps} projectGenre="Other" />);
      await waitFor(() => getPresetSelect());
      expect(getPresetSelect().value).toBe("");
    });

    it("matches the project genre case-insensitively", async () => {
      render(<ManageFieldsDialog {...defaultProps} projectGenre="fantasy" />);
      await waitFor(() => getPresetSelect());
      expect(getPresetSelect().value).toBe("Fantasy");
    });

    it("shows a portaled preview of the preset fields instead of applying immediately", async () => {
      const user = userEvent.setup();
      render(<ManageFieldsDialog {...defaultProps} projectGenre="Fantasy" />);
      await waitFor(() => screen.getByTestId("manage-fields-preset-apply"));

      await user.click(screen.getByTestId("manage-fields-preset-apply"));

      expect(mockApplyPreset).not.toHaveBeenCalled();
      const confirm = screen.getByTestId("manage-fields-preset-confirm-dialog");
      // 基本セット + ジャンル追加の中身が見える
      expect(confirm).toHaveTextContent("役割");
      expect(confirm).toHaveTextContent("種族");
      // dropdown は選択肢も見える
      expect(confirm).toHaveTextContent("主人公");
      // AnimatedOverlay (z-50, body portal) より上に出すための stacking 契約
      expect(confirm.parentElement).toBe(document.body);
      expect(confirm.className).toContain("z-[60]");
    });

    it("marks fields that already exist as skipped in the preview", async () => {
      const user = userEvent.setup();
      mockListDefs.mockResolvedValue([
        makeDefinition("def-1", "役割", "dropdown"),
      ]);
      render(<ManageFieldsDialog {...defaultProps} />);
      await waitFor(() => screen.getByTestId("manage-fields-preset-apply"));

      await user.click(screen.getByTestId("manage-fields-preset-apply"));

      const skip = screen.getByTestId("manage-fields-preset-skip");
      expect(skip).toHaveTextContent("役割");
    });

    it("applies the selected genre preset after confirming and reloads definitions", async () => {
      const user = userEvent.setup();
      mockApplyPreset.mockResolvedValue({
        added: [makeDefinition("preset-1", "役割", "dropdown")],
        skipped: 0,
      });
      render(<ManageFieldsDialog {...defaultProps} projectGenre="Fantasy" />);
      await waitFor(() => screen.getByTestId("manage-fields-preset-apply"));
      expect(mockListDefs).toHaveBeenCalledTimes(1);

      await user.click(screen.getByTestId("manage-fields-preset-apply"));
      await user.click(
        screen.getByTestId("manage-fields-preset-confirm-button"),
      );

      expect(mockApplyPreset).toHaveBeenCalledWith(
        "proj-1",
        "character",
        "Fantasy",
        "ja",
      );
      await waitFor(() => expect(mockListDefs).toHaveBeenCalledTimes(2));
      expect(
        screen.queryByTestId("manage-fields-preset-confirm-dialog"),
      ).not.toBeInTheDocument();
    });

    it("applies the base set as a null genre", async () => {
      const user = userEvent.setup();
      render(<ManageFieldsDialog {...defaultProps} />);
      await waitFor(() => screen.getByTestId("manage-fields-preset-apply"));

      await user.click(screen.getByTestId("manage-fields-preset-apply"));
      await user.click(
        screen.getByTestId("manage-fields-preset-confirm-button"),
      );

      expect(mockApplyPreset).toHaveBeenCalledWith(
        "proj-1",
        "character",
        null,
        "ja",
      );
    });

    it("lets the user pick a different genre before applying", async () => {
      const user = userEvent.setup();
      render(<ManageFieldsDialog {...defaultProps} projectGenre="Fantasy" />);
      await waitFor(() => getPresetSelect());

      await user.selectOptions(getPresetSelect(), "Mystery");
      await user.click(screen.getByTestId("manage-fields-preset-apply"));
      await user.click(
        screen.getByTestId("manage-fields-preset-confirm-button"),
      );

      expect(mockApplyPreset).toHaveBeenCalledWith(
        "proj-1",
        "character",
        "Mystery",
        "ja",
      );
    });

    it("does not apply when the preview is cancelled", async () => {
      const user = userEvent.setup();
      render(<ManageFieldsDialog {...defaultProps} />);
      await waitFor(() => screen.getByTestId("manage-fields-preset-apply"));

      await user.click(screen.getByTestId("manage-fields-preset-apply"));
      await user.click(
        screen.getByTestId("manage-fields-preset-cancel-button"),
      );

      expect(mockApplyPreset).not.toHaveBeenCalled();
      expect(
        screen.queryByTestId("manage-fields-preset-confirm-dialog"),
      ).not.toBeInTheDocument();
    });

    it("shows only a toast when every preset field already exists", async () => {
      const user = userEvent.setup();
      const baseNames = resolvePresetFields("character", null).map(
        (f) => f.name,
      );
      mockListDefs.mockResolvedValue(
        baseNames.map((name, i) => makeDefinition(`def-${i}`, name)),
      );
      render(<ManageFieldsDialog {...defaultProps} />);
      await waitFor(() => screen.getByTestId("manage-fields-preset-apply"));

      await user.click(screen.getByTestId("manage-fields-preset-apply"));

      expect(
        screen.queryByTestId("manage-fields-preset-confirm-dialog"),
      ).not.toBeInTheDocument();
      expect(mockApplyPreset).not.toHaveBeenCalled();
    });
  });

  describe("empty fields cleanup", () => {
    it("does not open a confirm when there are no empty fields", async () => {
      const user = userEvent.setup();
      mockListEmpty.mockResolvedValue([]);
      render(<ManageFieldsDialog {...defaultProps} />);
      await waitFor(() => screen.getByTestId("manage-fields-cleanup-button"));

      await user.click(screen.getByTestId("manage-fields-cleanup-button"));

      expect(mockListEmpty).toHaveBeenCalledWith("proj-1", "character");
      expect(
        screen.queryByTestId("manage-fields-cleanup-confirm-dialog"),
      ).not.toBeInTheDocument();
      expect(mockDeleteEmpty).not.toHaveBeenCalled();
    });

    it("opens a portaled confirm listing the empty fields", async () => {
      const user = userEvent.setup();
      mockListEmpty.mockResolvedValue([
        makeDefinition("def-1", "身長"),
        makeDefinition("def-2", "種族"),
      ]);
      render(<ManageFieldsDialog {...defaultProps} />);
      await waitFor(() => screen.getByTestId("manage-fields-cleanup-button"));

      await user.click(screen.getByTestId("manage-fields-cleanup-button"));

      const confirm = await screen.findByTestId(
        "manage-fields-cleanup-confirm-dialog",
      );
      expect(confirm).toHaveTextContent("身長");
      expect(confirm).toHaveTextContent("種族");
      // AnimatedOverlay (z-50, body portal) より上に出すための stacking 契約
      expect(confirm.parentElement).toBe(document.body);
      expect(confirm.className).toContain("z-[60]");
    });

    it("deletes empty fields and reloads the list on confirm", async () => {
      const user = userEvent.setup();
      mockListEmpty.mockResolvedValue([makeDefinition("def-1", "身長")]);
      mockDeleteEmpty.mockResolvedValue({
        deleted: [makeDefinition("def-1", "身長")],
        kept: 2,
      });
      render(<ManageFieldsDialog {...defaultProps} />);
      await waitFor(() => screen.getByTestId("manage-fields-cleanup-button"));
      expect(mockListDefs).toHaveBeenCalledTimes(1);

      await user.click(screen.getByTestId("manage-fields-cleanup-button"));
      await screen.findByTestId("manage-fields-cleanup-confirm-dialog");
      await user.click(
        screen.getByTestId("manage-fields-cleanup-confirm-button"),
      );

      expect(mockDeleteEmpty).toHaveBeenCalledWith("proj-1", "character");
      await waitFor(() => expect(mockListDefs).toHaveBeenCalledTimes(2));
      expect(
        screen.queryByTestId("manage-fields-cleanup-confirm-dialog"),
      ).not.toBeInTheDocument();
    });

    it("does not delete when the confirm is cancelled", async () => {
      const user = userEvent.setup();
      mockListEmpty.mockResolvedValue([makeDefinition("def-1", "身長")]);
      render(<ManageFieldsDialog {...defaultProps} />);
      await waitFor(() => screen.getByTestId("manage-fields-cleanup-button"));

      await user.click(screen.getByTestId("manage-fields-cleanup-button"));
      await screen.findByTestId("manage-fields-cleanup-confirm-dialog");
      await user.click(
        screen.getByTestId("manage-fields-cleanup-cancel-button"),
      );

      expect(mockDeleteEmpty).not.toHaveBeenCalled();
      expect(
        screen.queryByTestId("manage-fields-cleanup-confirm-dialog"),
      ).not.toBeInTheDocument();
    });
  });
});
