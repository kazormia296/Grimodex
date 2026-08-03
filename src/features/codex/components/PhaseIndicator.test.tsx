// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PhaseIndicator } from "./PhaseIndicator";
import type { CodexEntry } from "@/features/codex/api";
import type { CodexEntryPhase } from "@/features/codex/phaseApi";
import { buildSceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";
import type { TreeNodeData } from "@/features/tree/treeStore";

function scene(
  id: string,
  sortOrder: string,
  storyTimeOrder: string | null = null,
): TreeNodeData {
  return {
    id,
    projectId: "proj-1",
    parentId: null,
    nodeType: "scene",
    title: id,
    synopsis: null,
    intent: null,
    sortOrder,
    status: null,
    storyTimeOrder,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

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

const mockPhaseState = {
  phasesByEntry: {} as Record<string, CodexEntryPhase[]>,
  globalSceneOrder: new Map<string, number>(),
  sceneTimeIndex: buildSceneTimeIndex([
    scene("scene-1", "a0"),
    scene("scene-2", "a1"),
  ]),
  resolutionMode: "auto" as "reading" | "story" | "auto",
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
  nodes: [{ id: "scene-1", title: "シーン 1" }],
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
    mockPhaseState.sceneTimeIndex = buildSceneTimeIndex([
      scene("scene-1", "a0"),
      scene("scene-2", "a1"),
    ]);
    mockPhaseState.resolutionMode = "auto";
    mockPhaseState.loadPhasesForEntry = vi.fn().mockResolvedValue(undefined);
  });

  it("フェーズなし時は何も表示しない（nullレンダリング）", () => {
    mockPhaseState.phasesByEntry = {};
    const { container } = render(
      <PhaseIndicator
        entry={mockEntry}
        previewPhaseId={null}
        onPreviewChange={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("フェーズが存在する場合にPhaseドロップダウントリガーを表示する", () => {
    mockPhaseState.globalSceneOrder = new Map([
      ["scene-1", 0],
      ["scene-2", 1],
    ]);
    // アンカーがscene-2（現在scene-1より後）→ Base stateが現在
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
          version: 0,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ],
    };

    render(
      <PhaseIndicator
        entry={mockEntry}
        previewPhaseId={null}
        onPreviewChange={vi.fn()}
      />,
    );
    // ドロップダウントリガーが存在する
    expect(screen.getByText(/Phase:/)).toBeInTheDocument();
    // Base stateが現在なのでmini timelineにBaseが含まれる
    expect(screen.getByText("Base")).toBeInTheDocument();
  });

  it("アンカーシーンが現在シーン以前の場合フェーズラベルをmini timelineに表示する", () => {
    mockPhaseState.globalSceneOrder = new Map([["scene-1", 0]]);
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
          version: 0,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ],
    };

    render(
      <PhaseIndicator
        entry={mockEntry}
        previewPhaseId={null}
        onPreviewChange={vi.fn()}
      />,
    );
    // mini timelineに[変身後]が表示される
    expect(screen.getByText("[変身後]")).toBeInTheDocument();
  });

  it("mixed auto では未来 Phase を active 表示しない", () => {
    mockPhaseState.sceneTimeIndex = buildSceneTimeIndex([
      scene("scene-1", "a0"),
      scene("scene-8", "a1", "a0"),
    ]);
    mockPhaseState.phasesByEntry = {
      "entry-1": [
        {
          id: "future",
          entryId: "entry-1",
          label: "未来の姿",
          anchorNodeId: "scene-8",
          summaryOverride: null,
          contentOverride: null,
          contextModeOverride: null,
          version: 0,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ],
    };

    render(
      <PhaseIndicator
        entry={mockEntry}
        previewPhaseId={null}
        onPreviewChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Phase: Base state")).toBeInTheDocument();
    expect(screen.queryByText("[未来の姿]")).not.toBeInTheDocument();
  });
});
