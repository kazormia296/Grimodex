// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

import {
  listDefinitionsByType,
  listValuesByEntry,
  upsertValue,
} from "@/features/codex/detailApi";

const mockListDefs = vi.mocked(listDefinitionsByType);
const mockListValues = vi.mocked(listValuesByEntry);
const mockUpsert = vi.mocked(upsertValue);

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
});
