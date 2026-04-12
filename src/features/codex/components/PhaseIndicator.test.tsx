// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PhaseIndicator } from "./PhaseIndicator";
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

describe("PhaseIndicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPhaseState.phasesByEntry = {};
    mockPhaseState.getResolvedState = vi.fn().mockReturnValue(null);
  });

  it("フェーズなし時は何も表示しない（nullレンダリング）", () => {
    mockPhaseState.phasesByEntry = {};
    const { container } = render(<PhaseIndicator entry={mockEntry} />);
    expect(container.firstChild).toBeNull();
  });

  it("フェーズが1件以上ありappliedPhaseIdsが空の場合は「フェーズなし」バッジを表示する", () => {
    mockPhaseState.phasesByEntry = {
      "entry-1": [
        {
          id: "phase-1",
          entryId: "entry-1",
          label: "変身後",
          anchorNodeId: "scene-1",
          summaryOverride: null,
          contentOverride: null,
          contextModeOverride: null,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ],
    };
    mockPhaseState.getResolvedState = vi
      .fn()
      .mockReturnValue({ appliedPhaseIds: [] });

    render(<PhaseIndicator entry={mockEntry} />);
    expect(screen.getByText("フェーズなし")).toBeInTheDocument();
  });

  it("appliedPhaseIdsにIDがある場合は「現在のフェーズ: {label}」バッジを表示する", () => {
    mockPhaseState.phasesByEntry = {
      "entry-1": [
        {
          id: "phase-1",
          entryId: "entry-1",
          label: "変身後",
          anchorNodeId: "scene-1",
          summaryOverride: null,
          contentOverride: null,
          contextModeOverride: null,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ],
    };
    mockPhaseState.getResolvedState = vi
      .fn()
      .mockReturnValue({ appliedPhaseIds: ["phase-1"] });

    render(<PhaseIndicator entry={mockEntry} />);
    expect(screen.getByText("現在のフェーズ: 変身後")).toBeInTheDocument();
  });
});
