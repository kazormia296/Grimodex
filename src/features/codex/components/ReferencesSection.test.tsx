// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReferencesSection } from "./ReferencesSection";
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

vi.mock("@/features/codex/crossReference", () => ({
  buildCrossReferenceReport: vi.fn(),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: vi.fn(() => vi.fn()),
}));

import { buildCrossReferenceReport } from "@/features/codex/crossReference";
import { useTreeStore } from "@/features/tree/treeStore";

const mockBuildReport = vi.mocked(buildCrossReferenceReport);
const mockUseTreeStore = vi.mocked(useTreeStore);

describe("ReferencesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildReport.mockResolvedValue([]);
    mockUseTreeStore.mockReturnValue(vi.fn());
  });

  it("renders 'Appears in' section header", () => {
    render(<ReferencesSection entry={mockEntry} />);
    expect(screen.getByTestId("references-section")).toBeInTheDocument();
  });

  it("shows load button initially", () => {
    render(<ReferencesSection entry={mockEntry} />);
    expect(screen.getByTestId("references-load-button")).toBeInTheDocument();
  });

  it("calls buildCrossReferenceReport when load button is clicked", async () => {
    const user = userEvent.setup();
    render(<ReferencesSection entry={mockEntry} />);
    await user.click(screen.getByTestId("references-load-button"));
    expect(mockBuildReport).toHaveBeenCalledOnce();
  });

  it("shows 'not mentioned' message when entry has no scene mentions", async () => {
    const user = userEvent.setup();
    mockBuildReport.mockResolvedValue([
      {
        entryId: "entry-1",
        entryName: "アリス",
        entryType: "character",
        scenes: [],
      },
    ]);

    render(<ReferencesSection entry={mockEntry} />);
    await user.click(screen.getByTestId("references-load-button"));

    await waitFor(() => {
      expect(screen.getByTestId("references-empty")).toBeInTheDocument();
    });
  });

  it("shows scene list when entry has mentions", async () => {
    const user = userEvent.setup();
    mockBuildReport.mockResolvedValue([
      {
        entryId: "entry-1",
        entryName: "アリス",
        entryType: "character",
        scenes: [
          { sceneId: "scene-1", sceneTitle: "第一章", count: 3 },
          { sceneId: "scene-2", sceneTitle: "第二章", count: 1 },
        ],
      },
    ]);

    render(<ReferencesSection entry={mockEntry} />);
    await user.click(screen.getByTestId("references-load-button"));

    await waitFor(() => {
      expect(
        screen.getByTestId("references-scene-scene-1"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("references-scene-scene-2"),
      ).toBeInTheDocument();
      expect(screen.getByText("第一章")).toBeInTheDocument();
      expect(screen.getByText("第二章")).toBeInTheDocument();
    });
  });

  it("shows mention count next to scene name", async () => {
    const user = userEvent.setup();
    mockBuildReport.mockResolvedValue([
      {
        entryId: "entry-1",
        entryName: "アリス",
        entryType: "character",
        scenes: [{ sceneId: "scene-1", sceneTitle: "第一章", count: 3 }],
      },
    ]);

    render(<ReferencesSection entry={mockEntry} />);
    await user.click(screen.getByTestId("references-load-button"));

    await waitFor(() => {
      expect(screen.getByTestId("references-count-scene-1")).toHaveTextContent(
        "3",
      );
    });
  });

  it("calls setActiveScene when scene is clicked", async () => {
    const user = userEvent.setup();
    const setActiveScene = vi.fn();
    mockUseTreeStore.mockReturnValue(setActiveScene);
    mockBuildReport.mockResolvedValue([
      {
        entryId: "entry-1",
        entryName: "アリス",
        entryType: "character",
        scenes: [{ sceneId: "scene-1", sceneTitle: "第一章", count: 2 }],
      },
    ]);

    render(<ReferencesSection entry={mockEntry} />);
    await user.click(screen.getByTestId("references-load-button"));
    await waitFor(() => screen.getByTestId("references-scene-scene-1"));
    await user.click(screen.getByTestId("references-scene-scene-1"));

    expect(setActiveScene).toHaveBeenCalledWith("scene-1");
  });

  it("hides load button after loading", async () => {
    const user = userEvent.setup();
    render(<ReferencesSection entry={mockEntry} />);
    await user.click(screen.getByTestId("references-load-button"));
    await waitFor(() => screen.getByTestId("references-empty"));
    expect(
      screen.queryByTestId("references-load-button"),
    ).not.toBeInTheDocument();
  });
});
