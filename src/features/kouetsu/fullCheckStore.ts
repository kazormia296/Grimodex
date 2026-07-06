import { create } from "zustand";
import { useLintProjectStore } from "@/features/lint/lintProjectStore";
import {
  usePostEffectRunStore,
  type ActivePostEffectRun,
} from "@/features/post-effect/runStore";
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
   *   - outcome 未確定の post-effect run を run_id 単位で abort
   * intent の per-scene 直列は isCancelled コールバック経由で cancelRequested を
   * 読むため、ここでの abort 対象には含めない（次シーンを起動しないだけ）。
   */
  requestCancel: () => void;
}

/** 進行中の実 run を止める（フラグとは別に副作用として能動 abort）。 */
function abortActiveWork(): void {
  // lint スキャン（running 以外は no-op）。
  useLintProjectStore.getState().cancel();
  // 全体チェックは直列なので同時に走る post-effect run は現在の観点のものだけ。
  // outcome 未確定の run を run_id 単位で abort する（既存 runStore 構造に素直）。
  const runs = usePostEffectRunStore.getState().runs;
  for (const r of Object.values(runs) as ActivePostEffectRun[]) {
    if (r.outcome === undefined) {
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
