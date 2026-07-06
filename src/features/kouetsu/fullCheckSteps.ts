import { useTreeStore } from "@/features/tree/treeStore";
import { useLintProjectStore } from "@/features/lint/lintProjectStore";
import {
  runTypoCheck,
  runReviewCheck,
  runConsistencyCheck,
  runMetaStructureCheck,
  runTimelineCheck,
  runIntentDriftCheck,
  type KouetsuRunHooks,
  type KouetsuRunScope,
  type KouetsuRunOutcome,
} from "./runners";
import { useFullCheckStore, type FullCheckStepId } from "./fullCheckStore";

/**
 * fullCheckSteps.ts — 全体チェック 1 観点分の実行と outcome 正規化。
 *
 * オーケストレータ本体（fullCheck.ts）から切り出す（200 行分割）。ここは
 * 「観点 → runner 呼び出し → StepResult」への写像だけを担い、進捗集約や
 * トーストは fullCheck.ts に残す。
 */

/** 1 ステップの正規化結果。 */
export interface StepResult {
  /** 追加された指摘数（成功/スキップ時のみ）。 */
  count?: number;
  /** ハード失敗の理由（あれば failures へ積む）。 */
  error?: string;
  /** ガード拒否（全体を即中断。failures には積まない）。 */
  blocked?: boolean;
}

/** 単一 outcome を StepResult へ。 */
function normalize(o: KouetsuRunOutcome): StepResult {
  if (o.ok && "blocked" in o) return { blocked: true };
  if (o.ok && "skipped" in o) return { count: 0 };
  if (!o.ok) return { error: o.error };
  return { count: o.count };
}

/** consistency の {codex, intra} を 1 観点へ集約する。 */
function normalizePair(
  codex: KouetsuRunOutcome,
  intra: KouetsuRunOutcome,
): StepResult {
  if (codex.ok && "blocked" in codex && intra.ok && "blocked" in intra)
    return { blocked: true };
  // 両方ハード失敗のときだけ観点失敗（片方成功は成功分を数える）。
  if (!codex.ok && !intra.ok) return { error: codex.error };
  let count = 0;
  if (codex.ok && "count" in codex) count += codex.count;
  if (intra.ok && "count" in intra) count += intra.count;
  return { count };
}

/** lint 全章スキャン（folder/project スコープ時のみ到達）。 */
async function runLintStep(): Promise<StepResult> {
  const projectId = useTreeStore.getState().projectId;
  if (!projectId) return { count: 0 };
  await useLintProjectStore.getState().start(projectId);
  const st = useLintProjectStore.getState();
  if (st.phase === "error")
    return { error: st.fatalError ?? "lint scan failed" };
  const count = st.scenes.reduce((n, s) => n + s.diagnostics.length, 0);
  return { count };
}

/**
 * 1 観点を実行して正規化結果を返す。hooks.onRunStarted は各 run 起動時に
 * run_id を通知し、全体チェックが「自分が起動した run だけ」を中止対象へ
 * 絞るために使う（無関係の並走 run を巻き込まない）。
 */
export async function executeStep(
  step: FullCheckStepId,
  runScope: KouetsuRunScope,
  hooks?: KouetsuRunHooks,
): Promise<StepResult> {
  switch (step) {
    case "lint":
      return runLintStep();
    case "typo":
      return normalize(await runTypoCheck(runScope, hooks));
    case "consistency": {
      const { codex, intra } = await runConsistencyCheck(runScope, hooks);
      return normalizePair(codex, intra);
    }
    case "review":
      return normalize(await runReviewCheck(runScope, hooks));
    case "meta":
      return normalize(await runMetaStructureCheck(runScope, hooks));
    case "timeline":
      return normalize(await runTimelineCheck(hooks));
    case "intent":
      return normalize(
        await runIntentDriftCheck(runScope, {
          isCancelled: () => useFullCheckStore.getState().cancelRequested,
          onRunStarted: hooks?.onRunStarted,
        }),
      );
  }
}
