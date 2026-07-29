import { create } from "zustand";
import { cancelProjectLintScan } from "@/features/lint/projectScanCommands";
import { listRunningPostEffectRunTargets } from "@/features/post-effect/runProjection";
import { abortPostEffectRun } from "@/features/post-effect/api";

/**
 * fullCheckStore.ts — 全体チェック（観点直列オーケストレータ）の実行状態。
 *
 * 型と Zustand store のみをこの葉モジュールに置く（orchestrator 本体は
 * fullCheck.ts）。kouetsuStore は `FullCheckStepId` を type-only import する
 * ため、循環参照を避けるべく定義をここに集約する。
 */

export type FullCheckStepId =
  | "lint"
  | "typo"
  | "consistency"
  | "review"
  | "meta"
  | "timeline"
  | "intent";

/** 実行順（固定・直列）。lint→typo→consistency→review→meta→timeline→intent。 */
export const FULL_CHECK_STEP_ORDER: FullCheckStepId[] = [
  "lint",
  "typo",
  "consistency",
  "review",
  "meta",
  "timeline",
  "intent",
];

/** 各観点の表示ラベル i18n キー（進捗表示・失敗一覧・選択 UI で共有）。 */
export const FULL_CHECK_STEP_LABEL_KEY: Record<FullCheckStepId, string> = {
  lint: "settings.linter.proofreading",
  typo: "kouetsu.progressToast.effect.typo_detection",
  consistency: "kouetsu.progressToast.effect.consistency",
  review: "kouetsu.progressToast.effect.review",
  meta: "kouetsu.progressToast.effect.meta_structure",
  timeline: "kouetsu.progressToast.effect.timeline_consistency",
  intent: "kouetsu.progressToast.effect.intent_drift",
};

export interface FullCheckFailure {
  step: FullCheckStepId;
  error: string;
}

/**
 * 1 観点の per-step 進捗（パイプライン表示用の判別 union）。
 * skipped は「今回の run の対象外」を表す:
 *   - unchecked … 観点選択で OFF
 *   - sceneLint … scene スコープの live lint 済みにより除外された lint
 */
export type FullCheckStepState =
  | { state: "pending" }
  | { state: "running" }
  | { state: "done"; count: number }
  | { state: "error"; error: string }
  | { state: "skipped"; reason: "unchecked" | "sceneLint" };

export interface FullCheckState {
  running: boolean;
  currentStep: FullCheckStepId | null;
  /** 完了観点数。 */
  done: number;
  /** 対象観点数。 */
  total: number;
  failures: FullCheckFailure[];
  cancelRequested: boolean;
  /**
   * run のライフサイクル。"done" は完走・中止後もパイプラインを閉じる
   * （closePipeline）まで維持する。blocked（ガード拒否）時のみ "idle" へ戻る。
   * running フラグとは常に同期する（running === (runState === "running")）。
   */
  runState: "idle" | "running" | "done";
  /** 観点ごとの進捗。run 開始時に対象=pending / 非対象=skipped で初期化。 */
  steps: Record<FullCheckStepId, FullCheckStepState>;
  /** パイプラインステージの表示フラグ（実行中の「戻る」で false にできる）。 */
  pipelineVisible: boolean;
  /** 最後に完走した時刻（ISO）。中止・blocked では更新しない。 */
  lastFinishedAt: string | null;
  /** 完走 run の指摘合計。中止・blocked では更新しない。 */
  findingsTotal: number;
}

/** 全観点 pending の steps レコード（store 初期値用）。 */
function initialSteps(): Record<FullCheckStepId, FullCheckStepState> {
  const rec = {} as Record<FullCheckStepId, FullCheckStepState>;
  for (const id of FULL_CHECK_STEP_ORDER) rec[id] = { state: "pending" };
  return rec;
}

interface FullCheckActions {
  /**
   * 中止を要求する。フラグを立てるだけでなく、進行中の実 run を能動的に止める:
   *   - lint スキャン（AbortController）を cancel
   *   - **全体チェック自身が起動した** post-effect run（追跡集合
   *     `activeFullCheckRunIds`）のうち outcome 未確定のものを run_id 単位で abort
   * 手動起動の並走 run（疑似コメント・CurrentScene 単発・別 project multi）は
   * 追跡集合に無いので巻き込まない。intent の per-scene 直列も各 run が追跡集合に
   * 入るため、in-flight の 1 シーンは abort され、残りは isCancelled で起動されない。
   */
  requestCancel: () => void;
  /** パイプラインステージを再表示する（「実行中 n/N」pill からの復帰）。 */
  showPipeline: () => void;
  /** 実行中の「戻る」。run は継続したまま表示だけ畳む。 */
  hidePipeline: () => void;
  /**
   * パイプラインを閉じる。完了後（runState==="done"）は "idle" へ戻して
   * 次回のダッシュボード/サマリ表示に返す。実行中は表示のみ畳む
   * （runState は run の終了処理側で確定する）。
   */
  closePipeline: () => void;
}

/**
 * 全体チェックが「自分が起動した run」だけを中止対象にするための runId 集合。
 * runStore は手動起動の run（疑似コメント・単発・別 multi 等）も保持するため、
 * outcome 未確定 run を無差別に abort すると無関係な並走 run を巻き込む
 * （Rust 側で per-run 化した中止を FE で台無しにする回帰）。ここに記録した
 * runId だけを abort 対象にすることで全体チェック自身の run に限定する。
 * 反応性は不要（レンダリングに影響しない）ので module-level Set に置く。
 * orchestrator（fullCheck.ts）が各ステップ開始時に reset し、run 起動時に track する。
 */
const activeFullCheckRunIds = new Set<string>();

/** 現ステップで起動した run を追跡対象へ登録する（onRunStarted から呼ぶ）。 */
export function trackFullCheckRun(runId: string): void {
  activeFullCheckRunIds.add(runId);
}

/** 追跡集合をクリアする（各ステップ開始時・全体チェック終了時）。 */
export function resetFullCheckRuns(): void {
  activeFullCheckRunIds.clear();
}

/** 進行中の実 run を止める（フラグとは別に副作用として能動 abort）。 */
function abortActiveWork(): void {
  // lint スキャンの cancel は「全体チェックが lint ステップ実行中」に限定する。
  // ステップは直列 await なので、currentStep が lint を過ぎた後に active な
  // scan があればそれはユーザーが手動起動した無関係な再スキャン（ダッシュ
  // ボードの校正タイル等）であり、巻き込んで abort してはならない
  // （post-effect run の per-run 追跡と同じ isolation 方針）。
  if (useFullCheckStore.getState().currentStep === "lint") {
    cancelProjectLintScan();
  }
  // 全体チェック自身が起動した run に限定して abort する。集合に記録した runId を
  // runStore で引き、outcome 未確定（＝まだ実行中）のものだけを止める。既に終端した
  // 過去ステップの runId が集合に残っていても outcome フィルタで no-op になる。
  for (const run of listRunningPostEffectRunTargets(activeFullCheckRunIds)) {
    void abortPostEffectRun(run.runId, run.projectId);
  }
}

export const useFullCheckStore = create<FullCheckState & FullCheckActions>()(
  (set) => ({
    running: false,
    currentStep: null,
    done: 0,
    total: 0,
    failures: [],
    cancelRequested: false,
    runState: "idle",
    steps: initialSteps(),
    pipelineVisible: false,
    lastFinishedAt: null,
    findingsTotal: 0,
    requestCancel: () => {
      set({ cancelRequested: true });
      abortActiveWork();
    },
    showPipeline: () => set({ pipelineVisible: true }),
    hidePipeline: () => set({ pipelineVisible: false }),
    closePipeline: () =>
      set((s) =>
        s.runState === "done"
          ? { runState: "idle", pipelineVisible: false }
          : { pipelineVisible: false },
      ),
  }),
);
