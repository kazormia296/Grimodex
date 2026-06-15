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
  globalSceneOrder: new Map<string, number>(),
  resolutionMode: "auto" as "reading" | "story" | "auto",
  loadPhasesForEntry: vi.fn().mockResolvedValue(undefined),
  deletePhase: vi.fn().mockResolvedValue(undefined),
  createPhase: vi.fn(),
  updatePhase: vi.fn(),
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
  activeSceneId: "",
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
    mockPhaseState.globalSceneOrder = new Map();
    mockPhaseState.loadPhasesForEntry = vi.fn().mockResolvedValue(undefined);
    mockPhaseState.deletePhase = vi.fn().mockResolvedValue(undefined);
    mockPhaseState.resolutionMode = "auto";
  });

  it("フェーズなし時に説明テキストが表示される", async () => {
    mockPhaseState.phasesByEntry = { "entry-1": [] };
    render(<TimelineTab entry={mockEntry} />);
    await waitFor(() => {
      expect(
        screen.getByText("フェーズが設定されていません。"),
      ).toBeInTheDocument();
    });
  });

  it("「Add phase」ボタンが存在する", async () => {
    mockPhaseState.phasesByEntry = { "entry-1": [] };
    render(<TimelineTab entry={mockEntry} />);
    await waitFor(() => {
      expect(screen.getAllByText("フェーズを追加").length).toBeGreaterThan(0);
    });
  });

  it("マウント時にloadPhasesForEntryが呼ばれる", async () => {
    render(<TimelineTab entry={mockEntry} />);
    await waitFor(() => {
      expect(mockPhaseState.loadPhasesForEntry).toHaveBeenCalledWith("entry-1");
    });
  });

  it("フェーズがある場合にBase stateとフェーズラベルが表示される", async () => {
    mockPhaseState.globalSceneOrder = new Map([["scene-1", 0]]);
    mockPhaseState.phasesByEntry = {
      "entry-1": [
        {
          id: "phase-1",
          entryId: "entry-1",
          label: "変身後",
          anchorNodeId: "scene-1",
          summaryOverride: "変身した",
          contentOverride: null,
          contextModeOverride: null,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ],
    };
    render(<TimelineTab entry={mockEntry} />);
    await waitFor(() => {
      expect(screen.getByText("基本状態")).toBeInTheDocument();
      expect(screen.getByText("変身後")).toBeInTheDocument();
    });
  });

  describe("現在地マーカー", () => {
    const makePhase = (
      id: string,
      label: string,
      anchor: string,
    ): CodexEntryPhase => ({
      id,
      entryId: "entry-1",
      label,
      anchorNodeId: anchor,
      summaryOverride: null,
      contentOverride: null,
      contextModeOverride: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });

    it("activeScene が phase アンカー上の時は ▶ 行を出さず ◉ のみ", async () => {
      mockPhaseState.globalSceneOrder = new Map([
        ["scene-1", 0],
        ["scene-2", 1],
      ]);
      mockPhaseState.phasesByEntry = {
        "entry-1": [makePhase("phase-1", "変身後", "scene-2")],
      };
      mockTreeState.nodes = [
        { id: "scene-2", title: "対決", nodeType: "scene" } as never,
      ];
      mockTreeState.activeSceneId = "scene-2";

      render(<TimelineTab entry={mockEntry} />);
      await waitFor(() => {
        expect(screen.getByText("変身後")).toBeInTheDocument();
      });
      expect(screen.queryByText(/現在地:/)).not.toBeInTheDocument();
      expect(
        screen.queryByText("シーン未選択 — Base を適用中"),
      ).not.toBeInTheDocument();
    });

    it("activeScene が phase アンカー間にいる時は ▶ ここ 行が出る", async () => {
      mockPhaseState.globalSceneOrder = new Map([
        ["scene-1", 0],
        ["scene-2", 1],
        ["scene-3", 2],
      ]);
      mockPhaseState.phasesByEntry = {
        "entry-1": [
          makePhase("phase-1", "出会い", "scene-1"),
          makePhase("phase-2", "変身後", "scene-3"),
        ],
      };
      mockTreeState.nodes = [
        { id: "scene-2", title: "夜の街", nodeType: "scene" } as never,
      ];
      mockTreeState.activeSceneId = "scene-2";

      render(<TimelineTab entry={mockEntry} />);
      await waitFor(() => {
        expect(screen.getByText("現在地: 夜の街")).toBeInTheDocument();
      });
    });

    it("activeScene が最終 phase より後にいる時は ▶ ここ 行が末尾に出る", async () => {
      mockPhaseState.globalSceneOrder = new Map([
        ["scene-1", 0],
        ["scene-2", 1],
      ]);
      mockPhaseState.phasesByEntry = {
        "entry-1": [makePhase("phase-1", "出会い", "scene-1")],
      };
      mockTreeState.nodes = [
        { id: "scene-2", title: "終章", nodeType: "scene" } as never,
      ];
      mockTreeState.activeSceneId = "scene-2";

      render(<TimelineTab entry={mockEntry} />);
      await waitFor(() => {
        expect(screen.getByText("現在地: 終章")).toBeInTheDocument();
      });
    });

    it("activeSceneId が未設定なら Scene 文脈なし pill が出る", async () => {
      mockPhaseState.globalSceneOrder = new Map([["scene-1", 0]]);
      mockPhaseState.phasesByEntry = {
        "entry-1": [makePhase("phase-1", "出会い", "scene-1")],
      };
      mockTreeState.nodes = [];
      mockTreeState.activeSceneId = "";

      render(<TimelineTab entry={mockEntry} />);
      await waitFor(() => {
        expect(
          screen.getByText("シーン未選択 — Base を適用中"),
        ).toBeInTheDocument();
      });
      expect(screen.queryByText(/現在地:/)).not.toBeInTheDocument();
    });

    it("resolutionMode に応じた順序バッジが表示される", async () => {
      mockPhaseState.globalSceneOrder = new Map([["scene-1", 0]]);
      mockPhaseState.phasesByEntry = {
        "entry-1": [makePhase("phase-1", "出会い", "scene-1")],
      };
      mockPhaseState.resolutionMode = "story";

      render(<TimelineTab entry={mockEntry} />);
      await waitFor(() => {
        expect(screen.getByText("順序: 作中時間順")).toBeInTheDocument();
      });
    });

    it("activeSceneId が globalSceneOrder に無い（削除済み）時も pill が出る", async () => {
      mockPhaseState.globalSceneOrder = new Map([["scene-1", 0]]);
      mockPhaseState.phasesByEntry = {
        "entry-1": [makePhase("phase-1", "出会い", "scene-1")],
      };
      mockTreeState.nodes = [];
      mockTreeState.activeSceneId = "scene-deleted";

      render(<TimelineTab entry={mockEntry} />);
      await waitFor(() => {
        expect(
          screen.getByText("シーン未選択 — Base を適用中"),
        ).toBeInTheDocument();
      });
    });
  });

  describe("Exposure breakdown", () => {
    const makePhase = (
      id: string,
      label: string,
      anchor: string,
      contextModeOverride: string | null = null,
    ): CodexEntryPhase => ({
      id,
      entryId: "entry-1",
      label,
      anchorNodeId: anchor,
      summaryOverride: null,
      contentOverride: null,
      contextModeOverride,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });

    it("Phase が AI 露出だけのときは AI 露出件数のバッジが出る", async () => {
      mockPhaseState.globalSceneOrder = new Map([
        ["scene-1", 0],
        ["scene-2", 1],
      ]);
      mockPhaseState.phasesByEntry = {
        "entry-1": [
          makePhase("p1", "A", "scene-1"),
          makePhase("p2", "B", "scene-2"),
        ],
      };
      render(<TimelineTab entry={mockEntry} />);
      await waitFor(() => {
        expect(screen.getByTestId("phase-exposure-ai")).toHaveTextContent("2");
      });
    });

    it("Phase に hidden override があると Wiki 限定件数が反映される", async () => {
      mockPhaseState.globalSceneOrder = new Map([
        ["scene-1", 0],
        ["scene-2", 1],
        ["scene-3", 2],
      ]);
      mockPhaseState.phasesByEntry = {
        "entry-1": [
          makePhase("p1", "A", "scene-1"),
          makePhase("p2", "B", "scene-2", "hidden"),
          makePhase("p3", "C", "scene-3"),
        ],
      };
      render(<TimelineTab entry={mockEntry} />);
      await waitFor(() => {
        expect(screen.getByTestId("phase-exposure-ai")).toHaveTextContent("1");
        expect(screen.getByTestId("phase-exposure-wiki")).toHaveTextContent(
          "2",
        );
      });
    });

    it("Phase が無い時はバッジが出ない", async () => {
      mockPhaseState.phasesByEntry = { "entry-1": [] };
      render(<TimelineTab entry={mockEntry} />);
      await waitFor(() => {
        expect(
          screen.getByText("フェーズが設定されていません。"),
        ).toBeInTheDocument();
      });
      expect(screen.queryByTestId("phase-exposure-ai")).not.toBeInTheDocument();
    });
  });
});
