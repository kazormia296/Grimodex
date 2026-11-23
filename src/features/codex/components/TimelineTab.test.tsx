// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resolvePhaseContentSeed, TimelineTab } from "./TimelineTab";
import type { CodexEntry } from "@/features/codex/api";
import type { CodexEntryPhase } from "@/features/codex/phaseApi";
import { buildSceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { listEntryIdsWithOrphanedHiddenPhase } from "@/../electron/shared/readDomain/features/codex/context/codexAiVisibility";

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
    scene("scene-3", "a2"),
  ]),
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
    mockPhaseState.sceneTimeIndex = buildSceneTimeIndex([
      scene("scene-1", "a0"),
      scene("scene-2", "a1"),
      scene("scene-3", "a2"),
    ]);
    mockPhaseState.loadPhasesForEntry = vi.fn().mockResolvedValue(undefined);
    mockPhaseState.deletePhase = vi.fn().mockResolvedValue(undefined);
    mockPhaseState.resolutionMode = "auto";
    mockTreeState.nodes = [];
    mockTreeState.activeSceneId = "";
  });

  it("過去アンカーの Content seed に未来 Phase を混ぜない", () => {
    const phases: CodexEntryPhase[] = [
      {
        id: "early",
        entryId: "entry-1",
        label: "Early",
        anchorNodeId: "scene-1",
        summaryOverride: null,
        contentOverride: "early-content",
        contextModeOverride: null,
        version: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "future",
        entryId: "entry-1",
        label: "Future",
        anchorNodeId: "scene-3",
        summaryOverride: null,
        contentOverride: "future-content",
        contextModeOverride: null,
        version: 0,
        createdAt: "2024-01-02T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
      },
    ];

    expect(
      resolvePhaseContentSeed({
        phases,
        index: buildSceneTimeIndex([
          scene("scene-1", "a0"),
          scene("scene-2", "a1"),
          scene("scene-3", "a2"),
        ]),
        mode: "reading",
        anchorNodeId: "scene-2",
        baseContent: "base-content",
      }),
    ).toBe("early-content");
  });

  it("編集対象より後の同アンカー sibling を Content seed に混ぜない", () => {
    const phases: CodexEntryPhase[] = [
      {
        id: "target",
        entryId: "entry-1",
        label: "Target",
        anchorNodeId: "scene-1",
        summaryOverride: null,
        contentOverride: null,
        contextModeOverride: null,
        version: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "later-sibling",
        entryId: "entry-1",
        label: "Later",
        anchorNodeId: "scene-1",
        summaryOverride: null,
        contentOverride: "later-content",
        contextModeOverride: null,
        version: 0,
        createdAt: "2024-01-02T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
      },
    ];

    expect(
      resolvePhaseContentSeed({
        phases,
        index: buildSceneTimeIndex([scene("scene-1", "a0")]),
        mode: "reading",
        anchorNodeId: "scene-1",
        baseContent: "base-content",
        targetPhaseId: "target",
      }),
    ).toBe("base-content");
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

  it("PhaseDialog の autoFocus 後も追加トリガへフォーカスを戻す", async () => {
    mockPhaseState.phasesByEntry = { "entry-1": [] };
    render(<TimelineTab entry={mockEntry} />);

    const opener = await screen.findByRole("button", {
      name: "フェーズを追加",
    });
    opener.focus();
    fireEvent.click(opener);

    const phaseLabel = await screen.findByPlaceholderText(/追放後/);
    await waitFor(() => expect(phaseLabel).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: /キャンセル|Cancel/ }));
    await waitFor(() => expect(opener).toHaveFocus());
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
          version: 0,
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
      version: 0,
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

    it("mixed auto では未来 Phase を active にしない", async () => {
      mockPhaseState.sceneTimeIndex = buildSceneTimeIndex([
        scene("scene-1", "a0"),
        scene("scene-8", "a1", "a0"),
      ]);
      mockPhaseState.phasesByEntry = {
        "entry-1": [makePhase("future", "未来の姿", "scene-8")],
      };
      mockTreeState.nodes = [
        { id: "scene-1", title: "冒頭", nodeType: "scene" } as never,
        { id: "scene-8", title: "第8章", nodeType: "scene" } as never,
      ];
      mockTreeState.activeSceneId = "scene-1";

      render(<TimelineTab entry={mockEntry} />);
      await waitFor(() => {
        expect(screen.getByText("現在地: 冒頭")).toBeInTheDocument();
      });
      expect(screen.getByText("未来の姿")).not.toHaveClass("text-primary");
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
      version: 0,
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

  describe("起点を失った「AI に見せない」Phase（DR-MP4-46、Q-G3）", () => {
    const makePhase = (
      id: string,
      label: string,
      anchor: string | null,
      contextModeOverride: string | null = "hidden",
    ): CodexEntryPhase => ({
      id,
      entryId: "entry-1",
      label,
      anchorNodeId: anchor,
      summaryOverride: null,
      contentOverride: null,
      contextModeOverride,
      version: 0,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    const BANNER = "orphaned-hiding-phase-notice-timeline";

    it("null の起点の hidden Phase があると、先頭に role=status の警告帯が出て、Phase 名を挙げる", async () => {
      mockPhaseState.phasesByEntry = {
        "entry-1": [makePhase("p1", "正体の露見", null)],
      };
      render(<TimelineTab entry={mockEntry} />);
      const banner = await screen.findByTestId(BANNER);
      expect(banner).toHaveAttribute("role", "status");
      expect(banner).toHaveTextContent(
        "この Codex は、アプリ内の AI（チャット・エージェント・ビートなど）に渡りません。",
      );
      expect(banner).toHaveTextContent("「正体の露見」");
      expect(banner).toHaveTextContent(
        "起点の場面を選び直すと、その場面から『AI に見せない』が適用されます。Phase を削除すると、基本の設定に戻ります。",
      );
      // 閉じる・あとで・無視は付けない。
      expect(banner.querySelector("button")).toBeNull();
    });

    it("警告帯は 3 件まで名前を挙げ、超えた分は「ほか n 件」", async () => {
      mockPhaseState.phasesByEntry = {
        "entry-1": ["A", "B", "C", "D", "E"].map((l, i) =>
          makePhase(`p${i}`, l, null),
        ),
      };
      render(<TimelineTab entry={mockEntry} />);
      const banner = await screen.findByTestId(BANNER);
      expect(banner).toHaveTextContent("「A」、「B」、「C」 ほか 2 件");
      expect(banner).not.toHaveTextContent("「D」");
    });

    it("起点が読む順に無い hidden Phase（archived・削除済み）でも警告帯が出る。placeable な hidden では出ない", async () => {
      mockPhaseState.phasesByEntry = {
        "entry-1": [makePhase("p1", "古い起点", "scene-archived")],
      };
      const { unmount } = render(<TimelineTab entry={mockEntry} />);
      expect(await screen.findByTestId(BANNER)).toBeInTheDocument();
      unmount();

      mockPhaseState.phasesByEntry = {
        "entry-1": [makePhase("p1", "有効", "scene-2")],
      };
      render(<TimelineTab entry={mockEntry} />);
      await screen.findByText("有効");
      expect(screen.queryByTestId(BANNER)).not.toBeInTheDocument();
    });

    it("起点の選び直しで読む順に戻れば警告帯が消える（同じ判定から出ている）", async () => {
      const orphan = makePhase("p1", "直す前", null);
      mockPhaseState.phasesByEntry = { "entry-1": [orphan] };
      const { rerender } = render(<TimelineTab entry={mockEntry} />);
      expect(await screen.findByTestId(BANNER)).toBeInTheDocument();
      mockPhaseState.phasesByEntry = {
        "entry-1": [{ ...orphan, anchorNodeId: "scene-3" }],
      };
      rerender(<TimelineTab entry={mockEntry} />);
      await waitFor(() =>
        expect(screen.queryByTestId(BANNER)).not.toBeInTheDocument(),
      );
    });

    it("suppress・mentioned・always など「見せない」でない Phase は警告帯を出さず、行は『適用されていません』にとどめて『AI に渡りません』と書かない", async () => {
      mockPhaseState.phasesByEntry = {
        "entry-1": [
          makePhase("p1", "抑制", null, "suppress"),
          makePhase("p2", "常時", "scene-archived", "always"),
          makePhase("p3", "本文だけ", null, null),
        ],
      };
      render(<TimelineTab entry={mockEntry} />);
      await screen.findByText("抑制");
      expect(screen.queryByTestId(BANNER)).not.toBeInTheDocument();
      const reasons = screen.getAllByTestId("orphaned-phase-row-reason");
      expect(reasons).toHaveLength(3);
      expect(reasons[0]).toHaveTextContent(
        "起点の場面が外れています（場面を戻しても自動では戻りません）。この Phase は適用されていません。",
      );
      expect(reasons[1]).toHaveTextContent(
        "起点の場面が見つかりません（アーカイブ中の可能性があります）。この Phase は適用されていません。",
      );
      for (const r of reasons)
        expect(r).not.toHaveTextContent("AI に渡りません");
    });

    it("末尾の行は事実で 4 通りに分かれ、回復の 1 文が付く", async () => {
      mockPhaseState.phasesByEntry = {
        "entry-1": [
          makePhase("p1", "NH", null, "hidden"),
          makePhase("p2", "NO", null, "suppress"),
          makePhase("p3", "MH", "scene-archived", "hidden"),
          makePhase("p4", "MO", "scene-archived", "suppress"),
        ],
      };
      render(<TimelineTab entry={mockEntry} />);
      await screen.findByText("NH");
      const reasons = screen
        .getAllByTestId("orphaned-phase-row-reason")
        .map((e) => e.textContent);
      expect(reasons).toEqual([
        "起点の場面が外れています（場面の削除など。場面を戻しても自動では戻りません）。『AI に見せない』設定のため、この Codex はアプリ内の AI に渡りません。",
        "起点の場面が外れています（場面を戻しても自動では戻りません）。この Phase は適用されていません。",
        "起点の場面が見つかりません（アーカイブ中の可能性があります）。『AI に見せない』設定のため、この Codex はアプリ内の AI に渡りません。",
        "起点の場面が見つかりません（アーカイブ中の可能性があります）。この Phase は適用されていません。",
      ]);
      expect(
        screen.getAllByText(
          "鉛筆で起点の場面を選び直すか、ごみ箱で Phase を削除してください。",
        ),
      ).toHaveLength(4);
    });

    it("警告帯が出る Codex では『AI 露出: n』バッジを出さない（出ない Codex では今までどおり出る）", async () => {
      mockPhaseState.phasesByEntry = {
        "entry-1": [
          makePhase("ok", "有効", "scene-1", null),
          makePhase("orphan", "孤児", null),
        ],
      };
      const { unmount } = render(<TimelineTab entry={mockEntry} />);
      await screen.findByTestId(BANNER);
      expect(screen.queryByTestId("phase-exposure-ai")).not.toBeInTheDocument();
      unmount();

      mockPhaseState.phasesByEntry = {
        "entry-1": [makePhase("ok", "有効", "scene-1", null)],
      };
      render(<TimelineTab entry={mockEntry} />);
      expect(
        await screen.findByTestId("phase-exposure-ai"),
      ).toBeInTheDocument();
    });

    it("場面を解決できない間（index が空）は警告帯も『AI に渡りません』の行も出さず、従来の中立の文言のまま", async () => {
      mockPhaseState.sceneTimeIndex = buildSceneTimeIndex([]);
      mockPhaseState.phasesByEntry = {
        "entry-1": [makePhase("p1", "ロード中", null)],
      };
      render(<TimelineTab entry={mockEntry} />);
      await screen.findByText("ロード中");
      expect(screen.queryByTestId(BANNER)).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("orphaned-phase-row-reason"),
      ).not.toBeInTheDocument();
      expect(screen.getByText("アンカーシーン未設定")).toBeInTheDocument();
    });

    it("Codex 自身がすでに『AI に見せない』なら、Phase が理由でないので警告帯を出さない", async () => {
      mockPhaseState.phasesByEntry = {
        "entry-1": [makePhase("p1", "孤児", null)],
      };
      render(<TimelineTab entry={{ ...mockEntry, contextMode: "hidden" }} />);
      await screen.findByText("孤児");
      expect(screen.queryByTestId(BANNER)).not.toBeInTheDocument();
    });

    it("警告帯の有無は AI から閉じる規則（listEntryIdsWithOrphanedHiddenPhase）と常に一致する", async () => {
      const cases: Array<[string, CodexEntryPhase[]]> = [
        ["null×hidden", [makePhase("a", "a", null, "hidden")]],
        ["null×不明な mode", [makePhase("a", "a", null, "wat")]],
        ["missing×hidden", [makePhase("a", "a", "gone", "hidden")]],
        ["missing×suppress", [makePhase("a", "a", "gone", "suppress")]],
        ["missing×mentioned", [makePhase("a", "a", "gone", "mentioned")]],
        ["placeable×hidden", [makePhase("a", "a", "scene-2", "hidden")]],
        ["null×テキストのみ", [makePhase("a", "a", null, null)]],
        [
          "混在",
          [
            makePhase("a", "a", "scene-1", "hidden"),
            makePhase("b", "b", "gone", "suppress"),
          ],
        ],
      ];
      for (const [name, phases] of cases) {
        mockPhaseState.phasesByEntry = { "entry-1": phases };
        const { unmount } = render(<TimelineTab entry={mockEntry} />);
        await screen.findByText(phases[0].label);
        const closed = listEntryIdsWithOrphanedHiddenPhase({
          sceneTimeIndex: mockPhaseState.sceneTimeIndex,
          phasesByEntry: new Map([["entry-1", phases]]),
        }).has("entry-1");
        expect(screen.queryByTestId(BANNER) !== null, name).toBe(closed);
        unmount();
      }
    });

    it("鉛筆で開く PhaseDialog は、読む順にある場面だけを選べ、起点を失った Phase は場面の選び直しまで保存できない", async () => {
      mockTreeState.nodes = [
        { id: "scene-1", title: "第1場", nodeType: "scene" } as never,
        {
          id: "scene-archived",
          title: "しまった場面",
          nodeType: "scene",
        } as never,
      ];
      mockPhaseState.phasesByEntry = {
        "entry-1": [makePhase("p1", "古い起点", "scene-archived")],
      };
      Object.assign(mockPhaseState, { detailOverrides: {} });
      render(<TimelineTab entry={mockEntry} />);
      await screen.findByText("古い起点");
      const pencil = screen
        .getAllByRole("button")
        .find((b) => b.querySelector(".lucide-pencil"));
      fireEvent.click(pencil!);
      const select = document.querySelectorAll("select")[0];
      expect(
        [...select.querySelectorAll("option")].map((o) => o.value),
      ).toEqual(["", "scene-1"]);
      expect(
        screen.getByTestId("phase-dialog-anchor-missing"),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /保存|Save/ })).toBeDisabled();
    });

    it("削除確認の括弧に、見つからない場面の生の id を出さない", async () => {
      mockPhaseState.phasesByEntry = {
        "entry-1": [makePhase("p1", "古い起点", "scene-secret-id")],
      };
      render(<TimelineTab entry={mockEntry} />);
      await screen.findByText("古い起点");
      const trash = screen
        .getAllByRole("button")
        .filter((b) => b.querySelector(".lucide-trash-2"));
      fireEvent.click(trash[0]);
      await screen.findByText("このフェーズを削除しますか？");
      expect(
        screen.getByText(/「古い起点」（場面が見つかりません）/),
      ).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("scene-secret-id");
    });
  });
});
