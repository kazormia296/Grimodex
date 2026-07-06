import i18next from "i18next";
import { toast } from "sonner";
import { useTreeStore } from "@/features/tree/treeStore";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import type { KouetsuRunScope } from "./runners";
import type { KouetsuScope } from "./kouetsuStore";
import {
  FULL_CHECK_STEP_LABEL_KEY,
  FULL_CHECK_STEP_ORDER,
  useFullCheckStore,
  type FullCheckStepId,
} from "./fullCheckStore";
import { executeStep } from "./fullCheckSteps";

/**
 * fullCheck.ts — 全体チェックのオーケストレータ本体。
 *
 * 選択された観点を固定順（lint→typo→consistency→review→meta→timeline→intent）で
 * **1 つずつ直列に** await する。各 run は既存 runStore / 進捗トースト / OS 通知に
 * そのまま乗るため、ここでは進捗集約（done/total/currentStep）と完了サマリの
 * トーストだけを担う。continue-on-error（run_multi_task と同じ思想）。
 */

export {
  useFullCheckStore,
  FULL_CHECK_STEP_ORDER,
  FULL_CHECK_STEP_LABEL_KEY,
} from "./fullCheckStore";
export type {
  FullCheckStepId,
  FullCheckState,
  FullCheckFailure,
} from "./fullCheckStore";

/** KouetsuScope → runner 用 KouetsuRunScope。scene は activeSceneId 必須。 */
function toRunScope(scope: KouetsuScope): KouetsuRunScope | null {
  if (scope.type === "folder")
    return { type: "folder", anchorId: scope.anchorId };
  if (scope.type === "project") return { type: "project" };
  const sceneId = useTreeStore.getState().activeSceneId;
  return sceneId ? { type: "scene", sceneId } : null;
}

/** 完了サマリのトースト（全成功=success / 失敗あり=永続 warning）。 */
function finishToast(
  cancelled: boolean,
  failures: { step: FullCheckStepId }[],
  findings: number,
): void {
  if (failures.length > 0) {
    toast.warning(
      i18next.t("kouetsu.fullCheck.completedWithFailures", {
        failed: failures.length,
      }),
      {
        description: failures
          .map((f) => i18next.t(FULL_CHECK_STEP_LABEL_KEY[f.step]))
          .join(", "),
        duration: Infinity,
        closeButton: true,
      },
    );
    return;
  }
  // ユーザー中止時は完了成功を主張しない。
  if (cancelled) return;
  toast.success(i18next.t("kouetsu.fullCheck.completed", { count: findings }));
}

/**
 * 選択観点を固定順で直列実行する。二重起動はガード。scope は
 * useResolvedKouetsuScope() の値を渡す（scene は activeSceneId 必須）。
 */
export async function runFullCheck(
  scope: KouetsuScope,
  enabled: Record<FullCheckStepId, boolean>,
): Promise<void> {
  if (useFullCheckStore.getState().running) {
    toast.info(i18next.t("kouetsu.fullCheck.alreadyRunning"));
    return;
  }
  // ガードは冒頭で 1 回（各 runner も内部で guard するが、lint 全章スキャンを
  // 無駄に走らせないため AI ステップ前にここで弾く）。
  if (blockIfPolicyOff("analysis") || blockIfUnlicensed()) return;

  const runScope = toRunScope(scope);
  if (!runScope) return; // scene スコープで activeSceneId 無し（UI で disable 済み）。

  // scene スコープは live lint 済みなので lint を除外（total にも数えない）。
  const steps = FULL_CHECK_STEP_ORDER.filter(
    (id) => enabled[id] && !(id === "lint" && scope.type === "scene"),
  );
  if (steps.length === 0) return;

  useFullCheckStore.setState({
    running: true,
    currentStep: null,
    done: 0,
    total: steps.length,
    failures: [],
    cancelRequested: false,
  });

  let findings = 0;
  let blocked = false;
  for (const step of steps) {
    if (useFullCheckStore.getState().cancelRequested) break;
    useFullCheckStore.setState({ currentStep: step });
    const res = await executeStep(step, runScope);
    if (res.blocked) {
      blocked = true;
      break;
    }
    if (res.error != null) {
      useFullCheckStore.setState((s) => ({
        failures: [...s.failures, { step, error: res.error as string }],
      }));
    } else {
      findings += res.count ?? 0;
    }
    useFullCheckStore.setState((s) => ({ done: s.done + 1 }));
  }

  const { cancelRequested, failures } = useFullCheckStore.getState();
  useFullCheckStore.setState({ running: false, currentStep: null });

  // blocked（ガード拒否）はガードが既に toast 済み。完了トーストは出さない。
  if (!blocked) finishToast(cancelRequested, failures, findings);
}
