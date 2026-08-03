/**
 * UI から呼ぶ scaffold/再編の一括オーケストレーション。
 * クリック文脈(mode/rootRef)を scope に変換し、generate → apply まで通す。
 * policy gate は呼び出し元(ダイアログ submit)で済ませる前提。
 */
import { getCurrentProjectId } from "@/features/project/projectStore";
import { fetchProjectContext } from "@/features/project/contextAtoms";
import { isAiFeatureBlockedByPolicy } from "@/features/ai-policy/policyGuard";
import { useAiSettingsStore } from "@/features/chat/store";
import {
  assertAiOperationAuthorityCurrent,
  captureAiOperationAuthority,
} from "@/features/ai-audit/projectScope";
import { useTreeStore } from "../treeStore";
import {
  generateAiTreePlan,
  buildOutlineContext,
  stripSynopsisIfDisabled,
} from "./generate";
import { applyAiTreePlan } from "./applyPlan";
import { collectDescendants } from "./validate";
import type { AiTreeScope, ApplyResult } from "./types";

export interface RunAiTreeInput {
  mode: "scaffold" | "reorganize";
  rootRef: string | null;
  instruction: string;
  withSynopsis: boolean;
}

export async function runAiTreeGeneration(
  input: RunAiTreeInput,
): Promise<ApplyResult> {
  // runtime defense (L1): UI Dialog の gate と独立に、実行時チョークポイントでも
  // policy を弾く。Dialog 以外の将来の caller(再生成ボタン/agent/slash)が来ても
  // enforcement を継承する。Dialog は呼び出し前に blockIfPolicyOff で toast 済みのため
  // 通常経路ではここに到達しない(二重 toast を避けるため throw のみ)。
  if (isAiFeatureBlockedByPolicy("structureWrite")) {
    throw new Error("structureWrite policy is disabled");
  }
  if (input.withSynopsis && isAiFeatureBlockedByPolicy("bodyWrite")) {
    throw new Error("bodyWrite policy is disabled");
  }

  const auditAuthority = captureAiOperationAuthority(
    getCurrentProjectId(),
    input.rootRef ?? "project",
  );
  const nodes = useTreeStore.getState().nodes;
  const outline = buildOutlineContext(nodes, input.rootRef);
  const projectCtx = await fetchProjectContext(auditAuthority.projectId).catch(
    () => null,
  );

  const plan = await generateAiTreePlan({
    kind: input.mode,
    instruction: input.instruction,
    withSynopsis: input.withSynopsis,
    outline,
    rootRef: input.rootRef,
    auditAuthority,
    project: projectCtx
      ? {
          title: projectCtx.title,
          genre: projectCtx.genre,
          pov: projectCtx.pov,
          tense: projectCtx.tense,
          styleGuide: projectCtx.styleGuide,
          aiInstructions: projectCtx.aiInstructions,
          // en プロジェクトはスキャフォールドプロンプトを英語で組む。
          language: projectCtx.language,
        }
      : null,
  });

  // synopsis トグル OFF のときは AI が依頼外で付けた synopsis を破棄(bodyWrite
  // gate を素通りさせない)。toggle を唯一の権威にする。
  const safePlan = stripSynopsisIfDisabled(plan, input.withSynopsis);

  // editableIds = scope root 配下の既存ノード。validate の scope 判定(parentInScope)
  // と同じ collectDescendants を共有し、folder のみ walk する buildOutlineContext と
  // 乖離しないようにする(N2)。scaffold は move/rename しないので空。
  const scope: AiTreeScope = {
    allowedOps:
      input.mode === "scaffold" ? ["create"] : ["create", "move", "rename"],
    rootRef: input.rootRef,
    editableIds:
      input.mode === "reorganize"
        ? collectDescendants(nodes, input.rootRef)
        : new Set(),
  };

  assertAiOperationAuthorityCurrent(auditAuthority, getCurrentProjectId());
  return applyAiTreePlan(safePlan, {
    projectId: auditAuthority.projectId,
    source: "ai",
    model: useAiSettingsStore.getState().settings?.model ?? null,
    traceId: auditAuthority.operationId,
    scope,
  });
}
