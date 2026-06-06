import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { applyAiTreePlan } from "@/features/tree/aiScaffold/applyPlan";
import type { ValidationError } from "@/features/tree/aiScaffold/validate";
import type { AiTreePlan } from "@/features/tree/aiScaffold/types";
import { validateAiTreePlan } from "@/features/tree/aiScaffold/validate";
import type { ApplyResult } from "@/features/tree/aiScaffold/types";

/**
 * Agent 向けツリー plan 適用。プロジェクト全体スコープで structureWrite を要求。
 */
export async function agentApplyTreePlan(
  plan: AiTreePlan,
  opts: { model?: string | null; traceId?: string | null } = {},
): Promise<ApplyResult> {
  if (blockIfPolicyOff("structureWrite")) {
    throw new Error("structureWrite policy is off");
  }
  const hasSynopsis = plan.ops.some(
    (o) => o.op === "create" && o.synopsis != null && o.synopsis.trim() !== "",
  );
  if (hasSynopsis && blockIfPolicyOff("bodyWrite")) {
    throw new Error("bodyWrite policy is off (synopsis generation requested)");
  }

  const projectId = getCurrentProjectId();
  const nodes = useTreeStore.getState().nodes;
  const editableIds = new Set(nodes.map((n) => n.id));
  const scope = {
    allowedOps: ["create", "move", "rename"] as const,
    rootRef: null,
    editableIds,
  };

  const v = validateAiTreePlan(plan, nodes, projectId, {
    allowedOps: [...scope.allowedOps],
    rootRef: scope.rootRef,
    editableIds: scope.editableIds,
  });
  if (!v.ok) {
    const err = new Error(
      `Tree plan validation failed: ${v.errors.map((e: ValidationError) => e.code).join(", ")}`,
    );
    throw err;
  }

  return applyAiTreePlan(plan, {
    projectId,
    source: "ai",
    model: opts.model ?? null,
    traceId: opts.traceId ?? crypto.randomUUID(),
    scope: {
      allowedOps: [...scope.allowedOps],
      rootRef: scope.rootRef,
      editableIds: scope.editableIds,
    },
  });
}
