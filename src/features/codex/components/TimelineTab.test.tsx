// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TimelineTab } from "./TimelineTab";
import type { CodexEntry } from "@/features/codex/api";
import type { CodexEntryPhase } from "@/features/codex/phaseApi";

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

const mockPhaseState = {
  phasesByEntry: {} as Record<string, CodexEntryPhase[]>,
  loadPhasesForEntry: vi.fn().mockResolvedValue(undefined),
  deletePhase: vi.fn().mockResolvedValue(undefined),
  createPhase: vi.fn(),
  updatePhase: vi.fn(),
  getResolvedState: vi.fn().mockReturnValue(null),
  resolvedStates: {},
};

vi.mock("../phaseStore", () => ({
  usePhaseStore: Object.assign(
    (selector: (s: typeof mockPhaseState) => unknown) =>
      selector(mockPhaseState),
    { getState: () => mockPhaseState },
  ),
}));

const mockTreeState = {
  nodes: [],
};

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: Object.assign(
    (selector: (s: typeof mockTreeState) => unknown) => selector(mockTreeState),
    { getState: () => mockTreeState },
  ),
}));

describe("TimelineTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPhaseState.phasesByEntry = {};
    mockPhaseState.loadPhasesForEntry = vi.fn().mockResolvedValue(undefined);
    mockPhaseState.deletePhase = vi.fn().mockResolvedValue(undefined);
  });

  it("フェーズなし時にプレースホルダーが表示される", async () => {
    render(<TimelineTab entry={mockEntry} />);
    await waitFor(() => {
      expect(screen.getByText("フェーズはまだありません")).toBeInTheDocument();
    });
  });

  it("「+ フェーズを追加」ボタンが存在する", async () => {
    render(<TimelineTab entry={mockEntry} />);
    await waitFor(() => {
      expect(screen.getByText("フェーズを追加")).toBeInTheDocument();
    });
  });

  it("マウント時にloadPhasesForEntryが呼ばれる", async () => {
    render(<TimelineTab entry={mockEntry} />);
    await waitFor(() => {
      expect(mockPhaseState.loadPhasesForEntry).toHaveBeenCalledWith("entry-1");
    });
  });

  it("フェーズがある場合にフェーズカードを表示する", async () => {
    mockPhaseState.phasesByEntry = {
      "entry-1": [
        {
          id: "phase-1",
          entryId: "entry-1",
          label: "変身後",
          anchorNodeId: null,
          summaryOverride: null,
          contentOverride: null,
          contextModeOverride: null,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ],
    };
    render(<TimelineTab entry={mockEntry} />);
    await waitFor(() => {
      expect(screen.getByText("変身後")).toBeInTheDocument();
    });
  });
});
