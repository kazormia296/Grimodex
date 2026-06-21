// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  within,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DetailsSection } from "./DetailsSection";
import type { CodexEntry } from "@/features/codex/api";
import type {
  CodexDetailDefinition,
  DetailValueWithDefinition,
} from "@/features/codex/detailApi";

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
  tagsCache: null,
  contextMode: "mentioned",
  childrenBudget: "compact",
  sourceChatMessageId: null,
  notes: null,
  version: 0,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const makeDefinition = (
  id: string,
  name: string,
  fieldType: string,
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

const makeValueWithDef = (
  defId: string,
  name: string,
  fieldType: string,
  value: string | null,
): DetailValueWithDefinition => ({
  value: {
    id: `val-${defId}`,
    entryId: "entry-1",
    definitionId: defId,
    value,
  },
  definition: makeDefinition(defId, name, fieldType),
});

vi.mock("@/features/codex/detailApi", () => ({
  listDefinitionsByType: vi.fn(),
  listValuesByEntry: vi.fn(),
  upsertValue: vi.fn(),
}));

vi.mock("@/features/codex/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/codex/api")>();
  return { ...actual, getCodexEntry: vi.fn() };
});

const { mockUpsertOverride, mockDeleteOverride, phaseStoreState } = vi.hoisted(
  () => ({
    mockUpsertOverride: vi.fn(),
    mockDeleteOverride: vi.fn(),
    phaseStoreState: {
      detailOverrides: {} as Record<
        string,
        Array<{ phaseId: string; definitionId: string; value: string | null }>
      >,
    },
  }),
);

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) =>
      sel({
        detailOverrides: phaseStoreState.detailOverrides,
        upsertDetailOverride: mockUpsertOverride,
        deleteDetailOverride: mockDeleteOverride,
      }),
    ),
    {
      getState: vi.fn(() => ({
        detailOverrides: phaseStoreState.detailOverrides,
        upsertDetailOverride: mockUpsertOverride,
        deleteDetailOverride: mockDeleteOverride,
      })),
    },
  ),
}));

vi.mock("@/features/codex/components/PinEntryDialog", () => ({
  PinEntryDialog: ({
    open,
    selectionMode,
    tabs,
    onSelect,
    onClose,
  }: {
    open: boolean;
    selectionMode?: string;
    tabs?: string[];
    onSelect?: (entry: unknown) => void;
    onClose: () => void;
  }) =>
    open ? (
      <div
        data-testid="mock-pin-entry-dialog"
        data-selection-mode={selectionMode}
        data-tabs={(tabs ?? []).join(",")}
      >
        <button
          data-testid="mock-palette-pick-same"
          onClick={() =>
            onSelect?.({
              id: "ref-9",
              projectId: "proj-1",
              name: "ボブ",
              type: "character",
            })
          }
        />
        <button
          data-testid="mock-palette-pick-cross"
          onClick={() =>
            onSelect?.({
              id: "ref-x",
              projectId: "proj-OTHER",
              name: "外部",
              type: "character",
            })
          }
        />
        <button data-testid="mock-palette-close" onClick={onClose} />
      </div>
    ) : null,
}));

import {
  listDefinitionsByType,
  listValuesByEntry,
  upsertValue,
} from "@/features/codex/detailApi";
import { getCodexEntry } from "@/features/codex/api";

const mockListDefs = vi.mocked(listDefinitionsByType);
const mockListValues = vi.mocked(listValuesByEntry);
const mockUpsert = vi.mocked(upsertValue);
const mockGetEntry = vi.mocked(getCodexEntry);

describe("DetailsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDefs.mockResolvedValue([]);
    mockListValues.mockResolvedValue([]);
    mockUpsert.mockResolvedValue({
      id: "val-1",
      entryId: "entry-1",
      definitionId: "def-1",
      value: "test",
    });
    mockGetEntry.mockResolvedValue(undefined);
    phaseStoreState.detailOverrides = {};
  });

  it("shows 'No fields' message when no definitions exist", async () => {
    render(<DetailsSection entry={mockEntry} />);
    await waitFor(() => {
      expect(screen.getByTestId("details-section-empty")).toBeInTheDocument();
    });
  });

  it("renders 'Details' section header", async () => {
    render(<DetailsSection entry={mockEntry} />);
    await waitFor(() => {
      expect(screen.getByTestId("details-section-header")).toBeInTheDocument();
    });
  });

  it("renders [+ Add field] button", async () => {
    render(<DetailsSection entry={mockEntry} />);
    await waitFor(() => {
      expect(
        screen.getByTestId("details-add-field-button"),
      ).toBeInTheDocument();
    });
  });

  it("renders [⚙ Manage] button", async () => {
    render(<DetailsSection entry={mockEntry} />);
    await waitFor(() => {
      expect(screen.getByTestId("details-manage-button")).toBeInTheDocument();
    });
  });

  it("renders a text field with label", async () => {
    mockListDefs.mockResolvedValue([makeDefinition("def-1", "身長", "text")]);
    mockListValues.mockResolvedValue([]);

    render(<DetailsSection entry={mockEntry} />);
    await waitFor(() => {
      expect(screen.getByTestId("detail-field-def-1")).toBeInTheDocument();
      expect(screen.getByText("身長")).toBeInTheDocument();
    });
  });

  it("renders a dropdown field with options", async () => {
    const fieldConfig = JSON.stringify({ options: ["人間", "エルフ"] });
    mockListDefs.mockResolvedValue([
      makeDefinition("def-2", "種族", "dropdown", { fieldConfig }),
    ]);
    mockListValues.mockResolvedValue([]);

    render(<DetailsSection entry={mockEntry} />);
    await waitFor(() => {
      const select = screen.getByTestId("detail-field-dropdown-def-2");
      expect(select).toBeInTheDocument();
      expect(screen.getByText("人間")).toBeInTheDocument();
      expect(screen.getByText("エルフ")).toBeInTheDocument();
    });
  });

  it("shows current value in dropdown", async () => {
    const fieldConfig = JSON.stringify({ options: ["人間", "エルフ"] });
    mockListDefs.mockResolvedValue([
      makeDefinition("def-2", "種族", "dropdown", { fieldConfig }),
    ]);
    mockListValues.mockResolvedValue([
      makeValueWithDef("def-2", "種族", "dropdown", "エルフ"),
    ]);

    render(<DetailsSection entry={mockEntry} />);
    await waitFor(() => {
      const select = screen.getByTestId(
        "detail-field-dropdown-def-2",
      ) as HTMLSelectElement;
      expect(select.value).toBe("エルフ");
    });
  });

  it("calls upsertValue immediately when dropdown changes", async () => {
    const user = userEvent.setup();
    const fieldConfig = JSON.stringify({ options: ["人間", "エルフ"] });
    mockListDefs.mockResolvedValue([
      makeDefinition("def-2", "種族", "dropdown", { fieldConfig }),
    ]);
    mockListValues.mockResolvedValue([]);

    render(<DetailsSection entry={mockEntry} />);
    await waitFor(() => screen.getByTestId("detail-field-dropdown-def-2"));

    await user.selectOptions(
      screen.getByTestId("detail-field-dropdown-def-2"),
      "人間",
    );

    expect(mockUpsert).toHaveBeenCalledWith("entry-1", "def-2", "人間");
  });

  it("renders 🤖 icon for fields with includeInContext=1", async () => {
    mockListDefs.mockResolvedValue([
      makeDefinition("def-1", "身長", "text", { includeInContext: 1 }),
    ]);
    mockListValues.mockResolvedValue([]);

    render(<DetailsSection entry={mockEntry} />);
    await waitFor(() => {
      expect(screen.getByTestId("detail-include-context-def-1")).toHaveClass(
        "text-primary",
      );
    });
  });

  it("renders 🤖 icon inactive for fields with includeInContext=0", async () => {
    mockListDefs.mockResolvedValue([
      makeDefinition("def-1", "身長", "text", { includeInContext: 0 }),
    ]);
    mockListValues.mockResolvedValue([]);

    render(<DetailsSection entry={mockEntry} />);
    await waitFor(() => {
      expect(
        screen.getByTestId("detail-include-context-def-1"),
      ).not.toHaveClass("text-primary");
    });
  });

  it("opens ManageFieldsDialog when Manage button is clicked", async () => {
    const user = userEvent.setup();
    render(<DetailsSection entry={mockEntry} />);
    await waitFor(() => screen.getByTestId("details-manage-button"));

    await user.click(screen.getByTestId("details-manage-button"));
    expect(screen.getByTestId("manage-fields-dialog")).toBeInTheDocument();
  });

  it("renders text detail editors in compact mode", async () => {
    mockListDefs.mockResolvedValue([makeDefinition("def-1", "身長", "text")]);
    render(<DetailsSection entry={mockEntry} />);

    const field = await screen.findByTestId("detail-field-def-1");
    const editor = within(field).getByTestId("codex-content-editor");
    expect(editor.dataset.compact).toBe("true");
    expect(editor.className).not.toContain("min-h-[80px]");
  });

  describe("phase override editing", () => {
    const textDef = () => makeDefinition("def-1", "種族", "text");
    const baseValue = () => makeValueWithDef("def-1", "種族", "text", "人間");
    const PHASE = { id: "ph1", label: "第二幕" };

    it("shows resolved values read-only in preview mode", async () => {
      mockListDefs.mockResolvedValue([textDef()]);
      mockListValues.mockResolvedValue([baseValue()]);

      render(
        <DetailsSection
          entry={mockEntry}
          previewDetailValues={new Map([["def-1", "吸血鬼"]])}
        />,
      );

      const preview = await screen.findByTestId("detail-field-preview-def-1");
      expect(preview).toHaveTextContent("吸血鬼");
      expect(
        screen.queryByTestId("codex-content-editor"),
      ).not.toBeInTheDocument();
    });

    it("falls back to the base value in preview when no override applies", async () => {
      mockListDefs.mockResolvedValue([textDef()]);
      mockListValues.mockResolvedValue([baseValue()]);

      render(
        <DetailsSection entry={mockEntry} previewDetailValues={new Map()} />,
      );

      const preview = await screen.findByTestId("detail-field-preview-def-1");
      expect(preview).toHaveTextContent("人間");
    });

    it("creates a phase override seeded from the base value", async () => {
      const user = userEvent.setup();
      mockListDefs.mockResolvedValue([textDef()]);
      mockListValues.mockResolvedValue([baseValue()]);

      render(<DetailsSection entry={mockEntry} activePhase={PHASE} />);

      await user.click(
        await screen.findByTestId("detail-field-override-add-def-1"),
      );

      expect(mockUpsertOverride).toHaveBeenCalledWith("ph1", "def-1", "人間");
    });

    it("edits an existing phase override instead of the base value", async () => {
      mockListDefs.mockResolvedValue([textDef()]);
      mockListValues.mockResolvedValue([baseValue()]);
      phaseStoreState.detailOverrides = {
        ph1: [{ phaseId: "ph1", definitionId: "def-1", value: "吸血鬼" }],
      };

      render(<DetailsSection entry={mockEntry} activePhase={PHASE} />);

      const input = (await screen.findByTestId(
        "detail-field-override-input-def-1",
      )) as HTMLInputElement;
      expect(input.value).toBe("吸血鬼");
      // 上書き編集中は base エディタを出さない
      expect(
        screen.queryByTestId("codex-content-editor"),
      ).not.toBeInTheDocument();

      fireEvent.change(input, { target: { value: "真祖" } });
      fireEvent.blur(input);

      expect(mockUpsertOverride).toHaveBeenCalledWith("ph1", "def-1", "真祖");
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("removes a phase override and reverts to the base editor", async () => {
      const user = userEvent.setup();
      mockListDefs.mockResolvedValue([textDef()]);
      mockListValues.mockResolvedValue([baseValue()]);
      phaseStoreState.detailOverrides = {
        ph1: [{ phaseId: "ph1", definitionId: "def-1", value: "吸血鬼" }],
      };

      render(<DetailsSection entry={mockEntry} activePhase={PHASE} />);

      await user.click(
        await screen.findByTestId("detail-field-override-remove-def-1"),
      );

      expect(mockDeleteOverride).toHaveBeenCalledWith("ph1", "def-1");
    });

    it("renders a dropdown override with the field options", async () => {
      mockListDefs.mockResolvedValue([
        makeDefinition("def-2", "立場", "dropdown", {
          fieldConfig: JSON.stringify({ options: ["味方", "敵"] }),
        }),
      ]);
      mockListValues.mockResolvedValue([]);
      phaseStoreState.detailOverrides = {
        ph1: [{ phaseId: "ph1", definitionId: "def-2", value: "味方" }],
      };

      render(<DetailsSection entry={mockEntry} activePhase={PHASE} />);

      const select = (await screen.findByTestId(
        "detail-field-override-select-def-2",
      )) as HTMLSelectElement;
      expect(select.value).toBe("味方");

      fireEvent.change(select, { target: { value: "敵" } });

      expect(mockUpsertOverride).toHaveBeenCalledWith("ph1", "def-2", "敵");
    });

    it("offers no override controls without an active phase", async () => {
      mockListDefs.mockResolvedValue([textDef()]);
      mockListValues.mockResolvedValue([baseValue()]);

      render(<DetailsSection entry={mockEntry} />);

      await screen.findByTestId("detail-field-def-1");
      expect(
        screen.queryByTestId("detail-field-override-add-def-1"),
      ).not.toBeInTheDocument();
    });
  });

  describe("codex_reference field", () => {
    const refDefinition = () =>
      makeDefinition("def-ref", "所有者", "codex_reference");

    it("shows the referenced entry name instead of the raw id", async () => {
      mockListDefs.mockResolvedValue([refDefinition()]);
      mockListValues.mockResolvedValue([
        makeValueWithDef("def-ref", "所有者", "codex_reference", "entry-9"),
      ]);
      mockGetEntry.mockResolvedValue({
        ...mockEntry,
        id: "entry-9",
        name: "ボブ",
      });

      render(<DetailsSection entry={mockEntry} />);

      expect(await screen.findByText("ボブ")).toBeInTheDocument();
    });

    it("falls back to the raw id when the entry cannot be resolved", async () => {
      mockListDefs.mockResolvedValue([refDefinition()]);
      mockListValues.mockResolvedValue([
        makeValueWithDef("def-ref", "所有者", "codex_reference", "entry-9"),
      ]);
      mockGetEntry.mockResolvedValue(undefined);

      render(<DetailsSection entry={mockEntry} />);

      expect(await screen.findByText(/entry-9/)).toBeInTheDocument();
    });

    it("opens the Spotlight-style picker and saves the selected entry id", async () => {
      const user = userEvent.setup();
      mockListDefs.mockResolvedValue([refDefinition()]);

      render(<DetailsSection entry={mockEntry} />);
      await user.click(await screen.findByTestId("detail-field-ref-def-ref"));

      const picker = screen.getByTestId("mock-pin-entry-dialog");
      // Spotlight (PinEntryDialog) と同形式: 単一選択 + codex タブのみ
      expect(picker.getAttribute("data-selection-mode")).toBe("single");
      expect(picker.getAttribute("data-tabs")).toBe("codex");
      await user.click(screen.getByTestId("mock-palette-pick-same"));

      expect(mockUpsert).toHaveBeenCalledWith("entry-1", "def-ref", "ref-9");
      expect(
        screen.queryByTestId("mock-pin-entry-dialog"),
      ).not.toBeInTheDocument();
      // 選択直後から名前が表示される
      expect(screen.getByText("ボブ")).toBeInTheDocument();
    });

    it("ignores selections from another project", async () => {
      const user = userEvent.setup();
      mockListDefs.mockResolvedValue([refDefinition()]);

      render(<DetailsSection entry={mockEntry} />);
      await user.click(await screen.findByTestId("detail-field-ref-def-ref"));
      await user.click(screen.getByTestId("mock-palette-pick-cross"));

      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("clears the reference with the clear button", async () => {
      const user = userEvent.setup();
      mockListDefs.mockResolvedValue([refDefinition()]);
      mockListValues.mockResolvedValue([
        makeValueWithDef("def-ref", "所有者", "codex_reference", "entry-9"),
      ]);
      mockGetEntry.mockResolvedValue({
        ...mockEntry,
        id: "entry-9",
        name: "ボブ",
      });

      render(<DetailsSection entry={mockEntry} />);
      await screen.findByText("ボブ");

      await user.click(screen.getByTestId("detail-field-ref-clear-def-ref"));

      expect(mockUpsert).toHaveBeenCalledWith("entry-1", "def-ref", "");
      expect(screen.queryByText("ボブ")).not.toBeInTheDocument();
    });
  });
});
