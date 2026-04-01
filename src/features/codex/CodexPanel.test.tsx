import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodexPanel } from "./CodexPanel";
import { useCodexStore } from "./codexStore";
import type { CodexEntry } from "./api";

vi.mock("./api", () => ({
  listCodexEntries: vi.fn(() => Promise.resolve([])),
  createCodexEntry: vi.fn(),
  updateCodexEntry: vi.fn(),
  deleteCodexEntry: vi.fn(),
  listCodexEntriesByMessageId: vi.fn(() => Promise.resolve([])),
}));

vi.mock("./search", () => ({
  searchCodexEntries: vi.fn(() => Promise.resolve([])),
}));

import { listCodexEntries } from "./api";
const mockListCodexEntries = vi.mocked(listCodexEntries);

const mockEntries: CodexEntry[] = [
  {
    id: "codex-1",
    projectId: "proj-1",
    parentId: null,
    type: "character",
    name: "アリス",
    summary: "主人公",
    aliases: "[]",
    excludedAliases: "[]",
    tags: "主人公,ファンタジー",
    sourceChatMessageId: "msg-1",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "codex-2",
    projectId: "proj-1",
    parentId: null,
    type: "location",
    name: "不思議の国",
    summary: "舞台",
    aliases: "[]",
    excludedAliases: "[]",
    tags: "場所",
    sourceChatMessageId: null,
    createdAt: "2024-01-02T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
  },
  {
    id: "codex-3",
    projectId: "proj-1",
    parentId: null,
    type: "item",
    name: "魔法の鍵",
    summary: "重要アイテム",
    aliases: "[]",
    excludedAliases: "[]",
    tags: "アイテム",
    sourceChatMessageId: null,
    createdAt: "2024-01-03T00:00:00Z",
    updatedAt: "2024-01-03T00:00:00Z",
  },
];

describe("CodexPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCodexStore.setState({
      entries: [],
      searchQuery: "",
      filterType: null,
      isLoading: false,
    });
  });

  it("renders the panel with search and filter", () => {
    render(<CodexPanel />);

    expect(screen.getByTestId("codex-panel")).toBeInTheDocument();
    expect(screen.getByTestId("codex-search-input")).toBeInTheDocument();
    expect(screen.getByTestId("codex-filter-select")).toBeInTheDocument();
  });

  it("displays entry list", async () => {
    mockListCodexEntries.mockResolvedValue(mockEntries);
    render(<CodexPanel />);

    await waitFor(() => {
      expect(screen.getByText("アリス")).toBeInTheDocument();
    });
    expect(screen.getByText("不思議の国")).toBeInTheDocument();
    expect(screen.getByText("魔法の鍵")).toBeInTheDocument();
  });

  it("shows empty state when no entries", async () => {
    mockListCodexEntries.mockResolvedValue([]);
    render(<CodexPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("codex-empty-state")).toBeInTheDocument();
    });
  });

  it("shows entry detail when an entry is clicked", async () => {
    const user = userEvent.setup();
    mockListCodexEntries.mockResolvedValue(mockEntries);
    render(<CodexPanel />);

    await waitFor(() => {
      expect(screen.getByText("アリス")).toBeInTheDocument();
    });
    await user.click(screen.getByText("アリス"));

    expect(screen.getByTestId("codex-detail-view")).toBeInTheDocument();
    expect(screen.getAllByText("主人公").length).toBeGreaterThan(0);
  });

  it("calls setFilterType when filter is changed", async () => {
    const user = userEvent.setup();
    mockListCodexEntries.mockResolvedValue(mockEntries);
    render(<CodexPanel />);

    await waitFor(() => {
      expect(screen.getByText("アリス")).toBeInTheDocument();
    });

    mockListCodexEntries.mockResolvedValue([mockEntries[0]]);
    const filterSelect = screen.getByTestId(
      "codex-filter-select",
    ) as HTMLSelectElement;
    await user.selectOptions(filterSelect, "character");

    await waitFor(() => {
      expect(useCodexStore.getState().filterType).toBe("character");
    });
  });

  it("triggers search when search input changes", async () => {
    const user = userEvent.setup();
    const { searchCodexEntries } = await import("./search");
    vi.mocked(searchCodexEntries).mockResolvedValue([mockEntries[0]]);

    mockListCodexEntries.mockResolvedValue([]);
    render(<CodexPanel />);

    const searchInput = screen.getByTestId("codex-search-input");
    await user.type(searchInput, "アリス");

    await waitFor(() => {
      expect(useCodexStore.getState().searchQuery).toBe("アリス");
    });
  });

  it("shows delete button in detail view", async () => {
    const user = userEvent.setup();
    mockListCodexEntries.mockResolvedValue(mockEntries);
    render(<CodexPanel />);

    await waitFor(() => {
      expect(screen.getByText("アリス")).toBeInTheDocument();
    });
    await user.click(screen.getByText("アリス"));

    expect(screen.getByTestId("codex-delete-button")).toBeInTheDocument();
  });

  it("shows edit button in detail view", async () => {
    const user = userEvent.setup();
    mockListCodexEntries.mockResolvedValue(mockEntries);
    render(<CodexPanel />);

    await waitFor(() => {
      expect(screen.getByText("アリス")).toBeInTheDocument();
    });
    await user.click(screen.getByText("アリス"));

    expect(screen.getByTestId("codex-edit-button")).toBeInTheDocument();
  });

  it("returns to list when back button is clicked in detail view", async () => {
    const user = userEvent.setup();
    mockListCodexEntries.mockResolvedValue(mockEntries);
    render(<CodexPanel />);

    await waitFor(() => {
      expect(screen.getByText("アリス")).toBeInTheDocument();
    });
    await user.click(screen.getByText("アリス"));
    expect(screen.getByTestId("codex-detail-view")).toBeInTheDocument();

    await user.click(screen.getByTestId("codex-back-button"));
    expect(screen.queryByTestId("codex-detail-view")).not.toBeInTheDocument();
  });
});
