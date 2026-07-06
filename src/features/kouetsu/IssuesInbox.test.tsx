// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import { useKouetsuStore } from "./kouetsuStore";
import {
  useFullCheckStore,
  FULL_CHECK_STEP_ORDER,
  type FullCheckStepId,
  type FullCheckStepState,
} from "./fullCheckStore";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import {
  fromAnnotation,
  sortIssues,
  type UnifiedIssue,
} from "./triage/issueModel";
import type { PostEffectAnnotation } from "@/features/post-effect/types";

// ---------------------------------------------------------------------------
// モック — IPC 配管と重い依存連鎖だけを遮断し、triage/ の各ステージ・リストは
// 実物を描画する（統合トリアージ UI の挙動テスト）。
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  open: [] as import("./triage/issueModel").UnifiedIssue[],
  dismissed: [] as import("./triage/issueModel").UnifiedIssue[],
  refresh: vi.fn(),
  resolveIssue: vi.fn(async () => true),
  dismissIssue: vi.fn(async () => true),
  fixIssue: vi.fn(async () => true),
  restoreIssue: vi.fn(async () => true),
  jumpToIssue: vi.fn(),
  runCategoryCheck: vi.fn(async () => {}),
}));

// useUnifiedIssues / useEffectLastRuns は annotation/lens fetch・runStore 購読
// （IPC 層）を丸ごと避けるため固定データを注入する。
vi.mock("./triage/useUnifiedIssues", () => ({
  useUnifiedIssues: () => ({
    open: h.open,
    dismissed: h.dismissed,
    loading: false,
    refresh: h.refresh,
  }),
  useOnRunSettled: () => {},
}));

vi.mock("./triage/useEffectLastRuns", () => ({
  useEffectLastRuns: () => ({
    lastRuns: {},
    refresh: vi.fn(),
    loading: false,
  }),
}));

// issueActions は runners / lint / editor まで依存が伸びるため全面差し替え。
// canClose / canFixNow は表示分岐（解決/Fix ボタンの有無）に効く純関数なので
// 実装と同じ判定則のスタブを置く。
vi.mock("./triage/issueActions", () => ({
  openSceneInEditor: vi.fn(),
  jumpToIssue: h.jumpToIssue,
  canClose: (issue: { source: { kind: string } }) =>
    issue.source.kind === "annotation",
  canFixNow: (
    issue: { fixable: boolean; sceneId: string | null },
    activeSceneId: string | null,
  ) =>
    issue.fixable && issue.sceneId != null && issue.sceneId === activeSceneId,
  resolveIssue: h.resolveIssue,
  dismissIssue: h.dismissIssue,
  fixIssue: h.fixIssue,
  restoreIssue: h.restoreIssue,
  runCategoryCheck: h.runCategoryCheck,
}));

// RunControl の AI gate は provider readiness 依存でテスト環境では
// pending/disabled になりうるため enabled に固定する。
vi.mock("@/features/ai-policy/useAiGate", () => ({
  useAiGate: () => ({ presentation: "enabled", tooltip: null }),
}));

// 除外ビュー併設の校正無効化一覧はマウント時に listNodes 等の IPC を叩くためスタブ。
vi.mock("@/features/lint/LintDisablesView", () => ({
  DisablesView: () => <div data-testid="stub-disables" />,
}));

// runFullCheck（実 IPC・runner 連鎖）だけ差し替える。useFullCheckStore /
// STEP 定数は実物を使う（FullCheckControl.test.tsx と同手法）。
const { runFullCheckMock } = vi.hoisted(() => ({ runFullCheckMock: vi.fn() }));
vi.mock("./fullCheck", async (orig) => {
  const actual = await orig<typeof import("./fullCheck")>();
  return { ...actual, runFullCheck: runFullCheckMock };
});

// サイズ計測（ResizeObserver）はテストから直接制御する。false = 排他表示
// （従来挙動）、true = ダッシュボード共存。
const coexistState = vi.hoisted(() => ({ coexist: false }));
vi.mock("./triage/useStageCoexist", () => ({
  useStageCoexist: () => coexistState.coexist,
  STAGE_COEXIST_MIN_HEIGHT: 560,
  STAGE_COEXIST_MIN_WIDTH: 330,
}));

import { IssuesInbox } from "./IssuesInbox";

// ---------------------------------------------------------------------------
// フィクスチャ — UnifiedIssue はモックせず、実 annotation から fromAnnotation で作る
// ---------------------------------------------------------------------------

function ann(
  partial: Omit<Partial<PostEffectAnnotation>, "metadata"> & {
    id: string;
    category: string;
    metadata?: unknown;
  },
): PostEffectAnnotation {
  return {
    projectId: "p1",
    runId: "r1",
    anchorType: "scene_range",
    sceneId: "s1",
    rangeStart: 0,
    rangeEnd: 0,
    textSnapshot: null,
    persona: null,
    severity: null,
    content: "指摘タイトル",
    authorRole: "ai",
    parentId: null,
    status: "open",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...partial,
    metadata:
      typeof partial.metadata === "string"
        ? partial.metadata
        : JSON.stringify(partial.metadata ?? {}),
  } as unknown as PostEffectAnnotation;
}

function mustIssue(issue: UnifiedIssue | null): UnifiedIssue {
  if (!issue) throw new Error("fixture annotation が受信箱対象外");
  return issue;
}

// 重大度 3 段（high/mid/low）× 観点 3 種（consistency/review/typo）。
const OPEN_ISSUES: UnifiedIssue[] = sortIssues([
  mustIssue(
    fromAnnotation(
      ann({
        id: "c1",
        category: "consistency_anchor",
        severity: "error",
        content: "田中の年齢が矛盾しています",
        createdAt: "2026-07-03T00:00:00.000Z",
        metadata: {
          codex_ref: {
            entry_id: "e1",
            entry_name: "田中",
            source_field: "detail",
            detail_name: "年齢",
            expected_value: "17歳",
            found_value: "15歳",
            found_text: "十五歳",
            found_context: "彼は十五歳だった",
            confidence: "high",
            llm_reason: "設定と不一致",
            dismiss_key: "k1",
          },
        },
      }),
    ),
  ),
  mustIssue(
    fromAnnotation(
      ann({
        id: "r1",
        category: "review",
        severity: "warning",
        content: "冒頭が冗長です",
        createdAt: "2026-07-02T00:00:00.000Z",
        metadata: {},
      }),
    ),
  ),
  mustIssue(
    fromAnnotation(
      ann({
        id: "t1",
        category: "typo_anchor",
        severity: "suggestion",
        content: "「行なう」は送り仮名の誤りです",
        createdAt: "2026-07-01T00:00:00.000Z",
        metadata: {
          typo_ref: {
            category: "okurigana",
            found_text: "行なう",
            found_context: "式を行なう予定だ",
            suggestion: "行う",
            confidence: "high",
            llm_reason: "送り仮名",
            dismiss_key: "k2",
          },
        },
      }),
    ),
  ),
]);

const DISMISSED_ISSUES: UnifiedIssue[] = [
  mustIssue(
    fromAnnotation(
      ann({
        id: "d1",
        category: "review",
        status: "dismissed",
        content: "前に除外した指摘",
        metadata: { dismiss_source: "manual" },
      }),
    ),
  ),
];

const NODES = [
  {
    id: "act1",
    parentId: null,
    nodeType: "folder",
    title: "第一幕",
    sortOrder: "a",
  },
  {
    id: "s1",
    parentId: "act1",
    nodeType: "scene",
    title: "冒頭シーン",
    sortOrder: "a",
  },
] as unknown as TreeNodeData[];

function allPending(): Record<FullCheckStepId, FullCheckStepState> {
  return Object.fromEntries(
    FULL_CHECK_STEP_ORDER.map((id) => [id, { state: "pending" }]),
  ) as Record<FullCheckStepId, FullCheckStepState>;
}

beforeEach(() => {
  vi.clearAllMocks();
  coexistState.coexist = false;
  h.open = OPEN_ISSUES;
  h.dismissed = DISMISSED_ISSUES;
  useKouetsuStore.setState({
    scope: { type: "scene" },
    statusFilter: "open",
    selectedIssueId: null,
    dashboardOn: false,
    catFilter: null,
    fullCheckEffects: {
      lint: true,
      typo: true,
      consistency: true,
      review: true,
      meta: true,
      timeline: true,
      intent: true,
    },
  });
  useTreeStore.setState({ projectId: "p1", activeSceneId: "s1", nodes: NODES });
  useFullCheckStore.setState({
    running: false,
    currentStep: null,
    done: 0,
    total: 0,
    failures: [],
    cancelRequested: false,
    runState: "idle",
    steps: allPending(),
    pipelineVisible: false,
    lastFinishedAt: null,
    findingsTotal: 0,
  });
});

describe("IssuesInbox サマリーステージ", () => {
  it("開いている件数と重大度凡例が出る", () => {
    render(<IssuesInbox />);
    // 大きい件数（サマリー）+ 凡例（重大/注意/提案 各 1）
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("件の指摘が開いています")).toBeInTheDocument();
    expect(screen.getByText("重大 1")).toBeInTheDocument();
    expect(screen.getByText("注意 1")).toBeInTheDocument();
    expect(screen.getByText("提案 1")).toBeInTheDocument();
  });

  it("0 件では「開いている指摘はありません」", () => {
    h.open = [];
    render(<IssuesInbox />);
    expect(screen.getByText("開いている指摘はありません")).toBeInTheDocument();
    expect(
      screen.getByText("このスコープに開いている指摘はありません"),
    ).toBeInTheDocument();
  });
});

describe("IssuesInbox トリアージカード", () => {
  it("行クリックでカードが開き（title + 対比表示）、× で閉じる", () => {
    render(<IssuesInbox />);
    expect(screen.queryByText("本文へ")).toBeNull();

    fireEvent.click(screen.getByText("田中の年齢が矛盾しています"));
    expect(useKouetsuStore.getState().selectedIssueId).toBe("ann:c1");
    // カード（行と合わせて title が 2 箇所）+ consistency の対比ブロック
    expect(screen.getByText("本文へ")).toBeInTheDocument();
    expect(screen.getAllByText("田中の年齢が矛盾しています")).toHaveLength(2);
    expect(screen.getByText("CODEX 設定")).toBeInTheDocument();
    expect(screen.getByText("17歳")).toBeInTheDocument();
    expect(screen.getByText("15歳")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("閉じる"));
    expect(screen.queryByText("本文へ")).toBeNull();
    expect(useKouetsuStore.getState().selectedIssueId).toBeNull();
  });

  it("「解決」で resolveIssue が呼ばれ、次の open 項目へ遷移する（advanceFrom）", async () => {
    render(<IssuesInbox />);
    fireEvent.click(screen.getByText("田中の年齢が矛盾しています"));
    fireEvent.click(screen.getByText("解決"));

    await waitFor(() =>
      expect(useKouetsuStore.getState().selectedIssueId).toBe("ann:r1"),
    );
    expect(h.resolveIssue).toHaveBeenCalledTimes(1);
    expect(h.resolveIssue).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ann:c1" }),
    );
    expect(h.refresh).toHaveBeenCalled();
    // カードは次の項目（レビュー指摘）へ切り替わっている
    expect(screen.getAllByText("冒頭が冗長です")).toHaveLength(2);
  });

  it("「あとで」はステータス変更なしで次の項目へ", () => {
    render(<IssuesInbox />);
    fireEvent.click(screen.getByText("田中の年齢が矛盾しています"));
    fireEvent.click(screen.getByText("あとで"));

    expect(useKouetsuStore.getState().selectedIssueId).toBe("ann:r1");
    expect(h.resolveIssue).not.toHaveBeenCalled();
    expect(h.dismissIssue).not.toHaveBeenCalled();
  });

  it("行内クイック Fix は fixIssue を呼び、カードは開かない", async () => {
    render(<IssuesInbox />);
    fireEvent.click(screen.getByText("Fix"));

    await waitFor(() =>
      expect(h.fixIssue).toHaveBeenCalledWith(
        expect.objectContaining({ id: "ann:t1" }),
      ),
    );
    expect(useKouetsuStore.getState().selectedIssueId).toBeNull();
    expect(h.refresh).toHaveBeenCalled();
  });

  it("選択中の指摘がリストから消えたら選択を解除する", () => {
    const { rerender } = render(<IssuesInbox />);
    fireEvent.click(screen.getByText("田中の年齢が矛盾しています"));
    expect(useKouetsuStore.getState().selectedIssueId).toBe("ann:c1");
    // 解決等でリストから消えた状況（refresh 後の再取得結果）を注入
    h.open = OPEN_ISSUES.filter((i) => i.id !== "ann:c1");
    rerender(<IssuesInbox />);
    expect(useKouetsuStore.getState().selectedIssueId).toBeNull();
  });
});

describe("IssuesInbox 観点ダッシュボード", () => {
  it("田トグルでダッシュボードが出て、タイルクリックで観点フィルタ chip が付く", () => {
    render(<IssuesInbox />);
    fireEvent.click(screen.getByLabelText("観点ダッシュボード"));
    const dash = screen.getByTestId("triage-dashboard");
    expect(dash).toBeInTheDocument();

    // typo タイル（1 件）をクリック → 観点フィルタ
    const tile = within(dash)
      .getByText("誤字脱字")
      .closest('[role="button"]') as HTMLElement;
    fireEvent.click(tile);
    expect(useKouetsuStore.getState().catFilter).toBe("typo");
    expect(screen.getByText("観点: 誤字脱字")).toBeInTheDocument();

    // リストは typo 行のみに絞られる
    expect(
      screen.getByText("「行なう」は送り仮名の誤りです"),
    ).toBeInTheDocument();
    expect(screen.queryByText("冒頭が冗長です")).toBeNull();

    // chip クリックで解除
    fireEvent.click(screen.getByText("観点: 誤字脱字"));
    expect(useKouetsuStore.getState().catFilter).toBeNull();
    expect(screen.getByText("冒頭が冗長です")).toBeInTheDocument();
  });
});

describe("IssuesInbox ステータス pill", () => {
  it("開いている/除外の件数を実数表示し、切替で除外リスト + 再表示が出る", async () => {
    render(<IssuesInbox />);
    const openPill = screen.getByRole("button", { name: "Open 3" });
    expect(openPill).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "除外 1" }));
    expect(useKouetsuStore.getState().statusFilter).toBe("dismissed");
    expect(screen.getByRole("button", { name: "除外 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // 除外行 + 再表示ボタン + 校正無効化（DisablesView）併設
    expect(screen.getByText("前に除外した指摘")).toBeInTheDocument();
    expect(screen.getByTestId("stub-disables")).toBeInTheDocument();

    fireEvent.click(screen.getByText("再表示"));
    await waitFor(() =>
      expect(h.restoreIssue).toHaveBeenCalledWith(
        expect.objectContaining({ id: "ann:d1" }),
      ),
    );
    expect(h.refresh).toHaveBeenCalled();
  });
});

describe("IssuesInbox パイプラインステージ", () => {
  it("実行中 + pipelineVisible で表示され、行選択中は triage が勝つ", () => {
    render(<IssuesInbox />);
    act(() => {
      useFullCheckStore.setState({
        running: true,
        runState: "running",
        pipelineVisible: true,
        done: 2,
        total: 7,
      });
    });
    expect(screen.getByText("全体チェック — 現在シーン")).toBeInTheDocument();
    expect(screen.getByText("2/7 観点")).toBeInTheDocument();

    // 行選択 → モード優先順で triage が勝ちパイプラインは退避
    fireEvent.click(screen.getByText("冒頭が冗長です"));
    expect(screen.getByText("本文へ")).toBeInTheDocument();
    expect(screen.queryByText("全体チェック — 現在シーン")).toBeNull();

    // カードを閉じるとパイプラインへ戻る
    fireEvent.click(screen.getByLabelText("閉じる"));
    expect(screen.getByText("全体チェック — 現在シーン")).toBeInTheDocument();
  });

  it("全体チェック開始（実行ボタン）で選択が解除される（設計: 開始で選択解除）", () => {
    render(<IssuesInbox />);
    fireEvent.click(screen.getByText("田中の年齢が矛盾しています"));
    expect(useKouetsuStore.getState().selectedIssueId).toBe("ann:c1");

    fireEvent.click(screen.getByText("全体チェック"));
    expect(runFullCheckMock).toHaveBeenCalledWith(
      { type: "scene" },
      expect.objectContaining({ typo: true, review: true }),
    );
    // 選択が残るとモード優先順（triage > pipeline）でパイプラインが出ない
    expect(useKouetsuStore.getState().selectedIssueId).toBeNull();
  });

  it("田トグルはパイプライン表示を解除してダッシュボードへ切り替える", () => {
    render(<IssuesInbox />);
    act(() => {
      useFullCheckStore.setState({
        running: true,
        runState: "running",
        pipelineVisible: true,
        done: 1,
        total: 7,
      });
    });
    expect(screen.getByText("全体チェック — 現在シーン")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("観点ダッシュボード"));
    expect(screen.getByTestId("triage-dashboard")).toBeInTheDocument();
    expect(screen.queryByText("全体チェック — 現在シーン")).toBeNull();
    // 実行中は表示のみ畳む（run 自体は継続、ピルから復帰可能）
    expect(useFullCheckStore.getState().pipelineVisible).toBe(false);
    expect(useFullCheckStore.getState().runState).toBe("running");
  });

  it("完了後のパイプラインは田トグルで閉じる（runState done → idle）", () => {
    render(<IssuesInbox />);
    act(() => {
      useFullCheckStore.setState({
        runState: "done",
        pipelineVisible: true,
        findingsTotal: 4,
      });
    });
    expect(screen.getByText("完了 — 指摘 4件")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("観点ダッシュボード"));
    expect(useFullCheckStore.getState().runState).toBe("idle");
    expect(useFullCheckStore.getState().pipelineVisible).toBe(false);
  });

  it("実行中の「戻る」で畳み、ヘッダの「実行中 n/N」ピルで復帰する", () => {
    render(<IssuesInbox />);
    act(() => {
      useFullCheckStore.setState({
        running: true,
        runState: "running",
        pipelineVisible: true,
        done: 2,
        total: 7,
      });
    });
    fireEvent.click(screen.getByText("戻る"));
    expect(screen.queryByText("全体チェック — 現在シーン")).toBeNull();
    // 畳んでいる間も RunControl は実行中ピルを出す
    fireEvent.click(screen.getByText("実行中 2/7"));
    expect(screen.getByText("全体チェック — 現在シーン")).toBeInTheDocument();
  });
});

describe("IssuesInbox ステージ共存（サイズ十分 = coexist）", () => {
  it("coexist では dashboardOn でもサマリーが併存する", () => {
    coexistState.coexist = true;
    useKouetsuStore.setState({ dashboardOn: true });
    render(<IssuesInbox />);
    expect(screen.getByTestId("triage-dashboard")).toBeInTheDocument();
    expect(screen.getByText("件の指摘が開いています")).toBeInTheDocument();
  });

  it("coexist では選択カードとダッシュボードが併存する（サマリーとカードは排他）", () => {
    coexistState.coexist = true;
    useKouetsuStore.setState({ dashboardOn: true });
    render(<IssuesInbox />);
    fireEvent.click(screen.getByText("田中の年齢が矛盾しています"));
    expect(screen.getByTestId("triage-dashboard")).toBeInTheDocument();
    expect(screen.getByText("本文へ")).toBeInTheDocument();
    expect(screen.queryByText("件の指摘が開いています")).toBeNull();
  });

  it("coexist でなければ従来どおり排他（選択でカードのみ、サマリーも出ない）", () => {
    useKouetsuStore.setState({ dashboardOn: true });
    render(<IssuesInbox />);
    expect(screen.getByTestId("triage-dashboard")).toBeInTheDocument();
    expect(screen.queryByText("件の指摘が開いています")).toBeNull();

    fireEvent.click(screen.getByText("田中の年齢が矛盾しています"));
    expect(screen.queryByTestId("triage-dashboard")).toBeNull();
    expect(screen.getByText("本文へ")).toBeInTheDocument();
  });

  it("coexist でもパイプラインは排他（ダッシュボード・サマリーとも非表示）", () => {
    coexistState.coexist = true;
    useKouetsuStore.setState({ dashboardOn: true });
    render(<IssuesInbox />);
    act(() => {
      useFullCheckStore.setState({
        running: true,
        runState: "running",
        pipelineVisible: true,
        done: 1,
        total: 7,
      });
    });
    expect(screen.getByText("全体チェック — 現在シーン")).toBeInTheDocument();
    expect(screen.queryByTestId("triage-dashboard")).toBeNull();
    expect(screen.queryByText("件の指摘が開いています")).toBeNull();
  });
});
