import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { CodexManagementPanel } from "./CodexManagementPanel";
import { useCodexStore } from "./codexStore";
import type { CodexEntry } from "./api";

// Mock ResizeObserver for react-resizable-panels
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  ResizeObserverMock as unknown as typeof ResizeObserver;

// Mock react-resizable-panels to avoid jsdom issues
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    ...props
  }: {
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <div data-testid="resizable-group" {...props}>
      {children}
    </div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

// Mock TipTap - provide minimal editor mock
vi.mock("@tiptap/react", () => {
  const EditorContent = ({
    editor,
  }: {
    editor: { getHTML: () => string } | null;
  }) => {
    if (!editor) return null;
    return (
      <div
        data-testid="tiptap-editor"
        contentEditable
        suppressContentEditableWarning
      >
        {editor.getHTML()}
      </div>
    );
  };
  return {
    useEditor: (config: { content?: string }) => ({
      getHTML: () => config?.content ?? "",
      commands: {
        setContent: vi.fn(),
      },
      destroy: vi.fn(),
    }),
    EditorContent,
  };
});

vi.mock("@tiptap/starter-kit", () => ({
  default: {
    configure: () => ({}),
  },
}));

vi.mock("@/features/attribution/AuthorshipMark", () => ({
  AuthorshipMark: {},
}));

vi.mock("@/features/attribution/useAttribution", () => ({
  useAttribution: vi.fn(),
}));

vi.mock("@/features/attribution/applyInitialMarks", () => ({
  applyInitialAuthorshipMarks: vi.fn(),
}));

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

import { listCodexEntries, updateCodexEntry } from "./api";
const mockListCodexEntries = vi.mocked(listCodexEntries);
const mockUpdateCodexEntry = vi.mocked(updateCodexEntry);

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
  {
    id: "codex-4",
    projectId: "proj-1",
    parentId: null,
    type: "lore",
    name: "古代魔法",
    summary: "世界の魔法体系",
    aliases: "[]",
    excludedAliases: "[]",
    tags: "設定,魔法",
    sourceChatMessageId: "msg-2",
    createdAt: "2024-01-04T00:00:00Z",
    updatedAt: "2024-01-04T00:00:00Z",
  },
];

describe("CodexManagementPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCodexStore.setState({
      entries: [],
      searchQuery: "",
      filterType: null,
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Resizable Panel Layout ---

  describe("Resizable panel layout", () => {
    it("renders with resizable panel group containing left and right panels", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      expect(screen.getByTestId("codex-management-panel")).toBeInTheDocument();
      expect(screen.getByTestId("codex-list-panel")).toBeInTheDocument();
      expect(screen.getByTestId("codex-detail-panel")).toBeInTheDocument();
    });

    it("shows placeholder in right panel when no entry is selected", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      expect(
        screen.getByTestId("codex-detail-placeholder"),
      ).toBeInTheDocument();
    });
  });

  // --- Left Panel: Category filter + list ---

  describe("Left panel - list with category filters", () => {
    it("renders entry list in left panel", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      expect(screen.getByText("不思議の国")).toBeInTheDocument();
      expect(screen.getByText("魔法の鍵")).toBeInTheDocument();
      expect(screen.getByText("古代魔法")).toBeInTheDocument();
    });

    it("renders category filter buttons", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });

      expect(screen.getByTestId("codex-filter-all")).toBeInTheDocument();
      expect(screen.getByTestId("codex-filter-character")).toBeInTheDocument();
      expect(screen.getByTestId("codex-filter-location")).toBeInTheDocument();
      expect(screen.getByTestId("codex-filter-item")).toBeInTheDocument();
      expect(screen.getByTestId("codex-filter-lore")).toBeInTheDocument();
    });

    it("filters entries when category button is clicked", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });

      mockListCodexEntries.mockResolvedValue([mockEntries[0]]);
      await user.click(screen.getByTestId("codex-filter-character"));

      await waitFor(() => {
        expect(useCodexStore.getState().filterType).toBe("character");
      });
    });

    it("shows empty state when no entries exist", async () => {
      mockListCodexEntries.mockResolvedValue([]);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByTestId("codex-empty-state")).toBeInTheDocument();
      });
    });

    it("highlights selected entry in list", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("codex-entry-codex-1"));

      expect(screen.getByTestId("codex-entry-codex-1")).toHaveClass(
        "bg-accent",
      );
    });
  });

  // --- Right Panel: Entry detail with TipTap mini-editor ---

  describe("Right panel - entry detail with TipTap editor", () => {
    it("shows entry details when entry is selected", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("codex-entry-codex-1"));

      expect(screen.getByTestId("codex-detail-content")).toBeInTheDocument();
      expect(screen.getByDisplayValue("アリス")).toBeInTheDocument();
    });

    it("shows type badge and editable fields", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("codex-entry-codex-1"));

      // Name field
      expect(screen.getByTestId("codex-detail-name")).toBeInTheDocument();
      // Summary field
      expect(screen.getByTestId("codex-detail-summary")).toBeInTheDocument();
      // Tags field
      expect(screen.getByTestId("codex-detail-tags")).toBeInTheDocument();
      // Type selector
      expect(screen.getByTestId("codex-detail-type")).toBeInTheDocument();
    });

    it("saves changes when save button is clicked", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      mockUpdateCodexEntry.mockResolvedValue(mockEntries[0]);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("codex-entry-codex-1"));

      // Save without editing — should call update with current values
      await user.click(screen.getByTestId("codex-save-button"));

      await waitFor(() => {
        expect(mockUpdateCodexEntry).toHaveBeenCalledWith(
          "codex-1",
          expect.objectContaining({ name: "アリス" }),
        );
      });
    });

    it("deletes entry when delete button is clicked", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("codex-entry-codex-1"));
      await user.click(screen.getByTestId("codex-detail-delete"));

      await waitFor(() => {
        expect(
          screen.getByTestId("codex-detail-placeholder"),
        ).toBeInTheDocument();
      });
    });
  });

  // --- Source Chat Link ---

  describe("Source chat link", () => {
    it("shows source chat link when entry has sourceChatMessageId", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });
      // Entry 1 has sourceChatMessageId: "msg-1"
      await user.click(screen.getByTestId("codex-entry-codex-1"));

      expect(screen.getByTestId("codex-source-chat-link")).toBeInTheDocument();
    });

    it("does not show source chat link when entry has no sourceChatMessageId", async () => {
      const user = userEvent.setup();
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("不思議の国")).toBeInTheDocument();
      });
      // Entry 2 has sourceChatMessageId: null
      await user.click(screen.getByTestId("codex-entry-codex-2"));

      expect(
        screen.queryByTestId("codex-source-chat-link"),
      ).not.toBeInTheDocument();
    });
  });

  // --- Command Palette (Ctrl+K) ---

  describe("Command palette (Ctrl+K)", () => {
    it("opens command palette when Ctrl+K is pressed", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });

      fireEvent.keyDown(document, { key: "k", ctrlKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("codex-command-palette")).toBeInTheDocument();
      });
    });

    it("closes command palette when Escape is pressed", async () => {
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });

      fireEvent.keyDown(document, { key: "k", ctrlKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("codex-command-palette")).toBeInTheDocument();
      });

      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(() => {
        expect(
          screen.queryByTestId("codex-command-palette"),
        ).not.toBeInTheDocument();
      });
    });

    it("searches entries in command palette and selects result", async () => {
      const user = userEvent.setup();
      const { searchCodexEntries } = await import("./search");
      vi.mocked(searchCodexEntries).mockResolvedValue([mockEntries[0]]);
      mockListCodexEntries.mockResolvedValue(mockEntries);
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });

      fireEvent.keyDown(document, { key: "k", ctrlKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("codex-command-palette")).toBeInTheDocument();
      });

      const searchInput = screen.getByTestId("codex-command-input");
      await user.type(searchInput, "アリス");

      await waitFor(() => {
        expect(
          screen.getByTestId("codex-command-result-codex-1"),
        ).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("codex-command-result-codex-1"));

      // Command palette closes and entry is selected
      await waitFor(() => {
        expect(
          screen.queryByTestId("codex-command-palette"),
        ).not.toBeInTheDocument();
      });
      expect(screen.getByTestId("codex-detail-content")).toBeInTheDocument();
    });
  });

  // --- Integration: Register → Search → Edit → Source reference ---

  describe("Integration: register → search → edit → source reference", () => {
    it("completes full workflow: search → select → edit → verify source", async () => {
      const user = userEvent.setup();
      const { searchCodexEntries } = await import("./search");
      vi.mocked(searchCodexEntries).mockResolvedValue([mockEntries[0]]);
      mockListCodexEntries.mockResolvedValue(mockEntries);
      mockUpdateCodexEntry.mockResolvedValue({
        ...mockEntries[0],
        name: "アリス改",
      });
      render(<CodexManagementPanel />);

      await waitFor(() => {
        expect(screen.getByText("アリス")).toBeInTheDocument();
      });

      // Step 1: Search via command palette
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });
      await waitFor(() => {
        expect(screen.getByTestId("codex-command-palette")).toBeInTheDocument();
      });

      const searchInput = screen.getByTestId("codex-command-input");
      await user.type(searchInput, "アリス");

      await waitFor(() => {
        expect(
          screen.getByTestId("codex-command-result-codex-1"),
        ).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("codex-command-result-codex-1"));

      // Step 2: Detail view is shown
      await waitFor(() => {
        expect(screen.getByTestId("codex-detail-content")).toBeInTheDocument();
      });

      // Step 3: Save the entry
      await user.click(screen.getByTestId("codex-save-button"));

      await waitFor(() => {
        expect(mockUpdateCodexEntry).toHaveBeenCalled();
      });

      // Step 4: Source chat link is visible
      expect(screen.getByTestId("codex-source-chat-link")).toBeInTheDocument();
    });
  });
});
