/**
 * UI から呼ぶ scaffold/再編の一括オーケストレーション。
 * クリック文脈(mode/rootRef)を scope に変換し、generate → apply まで通す。
 * policy gate は呼び出し元(ダイアログ submit)で済ませる前提。
 */
import { getCurrentProjectId } from "@/features/project/projectStore";
import { fetchProjectContext } from "@/features/project/contextAtoms";
import { useAiSettingsStore } from "@/features/chat/store";
import { useTreeStore } from "../treeStore";
import {
  generateAiTreePlan,
  buildOutlineContext,
  stripSynopsisIfDisabled,
} from "./generate";
import { applyAiTreePlan } from "./applyPlan";
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
  const projectId = getCurrentProjectId();
  const nodes = useTreeStore.getState().nodes;
  const outline = buildOutlineContext(nodes, input.rootRef);
  const projectCtx = await fetchProjectContext(projectId).catch(() => null);

  const plan = await generateAiTreePlan({
    kind: input.mode,
    instruction: input.instruction,
    withSynopsis: input.withSynopsis,
    outline,
    rootRef: input.rootRef,
    project: projectCtx
      ? {
          title: projectCtx.title,
          genre: projectCtx.genre,
          pov: projectCtx.pov,
          tense: projectCtx.tense,
          styleGuide: projectCtx.styleGuide,
          aiInstructions: projectCtx.aiInstructions,
        }
      : null,
  });

  // synopsis トグル OFF のときは AI が依頼外で付けた synopsis を破棄(bodyWrite
  // gate を素通りさせない)。toggle を唯一の権威にする。
  const safePlan = stripSynopsisIfDisabled(plan, input.withSynopsis);

  // editableIds = scope root 配下の既存ノード(= outline の id 集合)。
  // scaffold は move/rename しないので空。
  const scope: AiTreeScope = {
    allowedOps:
      input.mode === "scaffold" ? ["create"] : ["create", "move", "rename"],
    rootRef: input.rootRef,
    editableIds:
      input.mode === "reorganize"
        ? new Set(outline.map((n) => n.id))
        : new Set(),
  };

  return applyAiTreePlan(safePlan, {
    projectId,
    source: "ai",
    model: useAiSettingsStore.getState().settings?.model ?? null,
    traceId: crypto.randomUUID(),
    scope,
  });
}
