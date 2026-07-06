import { create } from "zustand";
import { useLintProjectStore } from "@/features/lint/lintProjectStore";
import { usePostEffectRunStore } from "@/features/post-effect/runStore";
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

export interface FullCheckState {
  running: boolean;
  currentStep: FullCheckStepId | null;
  /** 完了観点数。 */
  done: number;
  /** 対象観点数。 */
  total: number;
  failures: FullCheckFailure[];
  cancelRequested: boolean;
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
  // lint スキャン（running 以外は no-op）。lintProjectStore は単一 scan 構造
  // （activeController が 1 本）なので、全体チェックが起動した scan のみが active。
  useLintProjectStore.getState().cancel();
  // 全体チェック自身が起動した run に限定して abort する。集合に記録した runId を
  // runStore で引き、outcome 未確定（＝まだ実行中）のものだけを止める。既に終端した
  // 過去ステップの runId が集合に残っていても outcome フィルタで no-op になる。
  const runs = usePostEffectRunStore.getState().runs;
  for (const runId of activeFullCheckRunIds) {
    const r = runs[runId];
    if (r && r.outcome === undefined) {
      void abortPostEffectRun(r.runId, r.projectId);
    }
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
    requestCancel: () => {
      set({ cancelRequested: true });
      abortActiveWork();
    },
  }),
);
