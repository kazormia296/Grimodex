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
  globalSceneOrder: new Map<string, number>(),
  loadPhasesForEntry: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../phaseStore", () => ({
  usePhaseStore: Object.assign(
    (selector: (s: typeof mockPhaseState) => unknown) =>
      selector(mockPhaseState),
    { getState: () => mockPhaseState },
  ),
}));

const mockTreeState = {
  activeSceneId: "scene-1",
};

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: Object.assign(
    (selector: (s: typeof mockTreeState) => unknown) => selector(mockTreeState),
    { getState: () => mockTreeState },
  ),
}));

describe("PhaseIndicator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPhaseState.phasesByEntry = {};
    mockPhaseState.globalSceneOrder = new Map();
    mockPhaseState.loadPhasesForEntry = vi.fn().mockResolvedValue(undefined);
  });

  it("フェーズなし時は何も表示しない（nullレンダリング）", () => {
    mockPhaseState.phasesByEntry = {};
    const { container } = render(<PhaseIndicator entry={mockEntry} />);
    expect(container.firstChild).toBeNull();
  });

  it("フェーズが存在するが現在シーンより後のアンカーの場合「フェーズなし」バッジを表示する", () => {
    // シーン順序: scene-1=0, scene-2=1
    mockPhaseState.globalSceneOrder = new Map([
      ["scene-1", 0],
      ["scene-2", 1],
    ]);
    // フェーズのアンカーはscene-2（現在scene-1より後）
    mockPhaseState.phasesByEntry = {
      "entry-1": [
        {
          id: "phase-1",
          entryId: "entry-1",
          label: "変身後",
          anchorNodeId: "scene-2",
          summaryOverride: null,
          contentOverride: null,
          contextModeOverride: null,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ],
    };

    render(<PhaseIndicator entry={mockEntry} />);
    expect(screen.getByText("フェーズなし")).toBeInTheDocument();
  });

  it("アンカーシーンが現在シーン以前の場合「現在のフェーズ: {label}」バッジを表示する", () => {
    // シーン順序: scene-1=0, scene-2=1
    mockPhaseState.globalSceneOrder = new Map([
      ["scene-1", 0],
      ["scene-2", 1],
    ]);
    // アンカーがscene-1（=現在シーン）なので適用される
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

    render(<PhaseIndicator entry={mockEntry} />);
    expect(screen.getByText("現在のフェーズ: 変身後")).toBeInTheDocument();
  });
});
