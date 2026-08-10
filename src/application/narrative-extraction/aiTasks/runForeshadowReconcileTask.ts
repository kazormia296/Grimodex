import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_FORESHADOW_GLOBAL_RECONCILE_PATH =
  "narrative_foreshadow_global_reconcile" as const;

export interface RunForeshadowReconcileTaskInput {
  readonly scopeRef: string;
  readonly hypothesisSummaries: readonly {
    readonly threadHypothesisId: string;
    readonly titleSuggestion: string;
    readonly setupCount: number;
    readonly payoffCount: number;
  }[];
  readonly projectId?: string | null;
  readonly repairOnFailure?: boolean;
}

export interface ForeshadowReconcileAiResult {
  readonly scopeRef: string;
  readonly merges: readonly {
    readonly fromThreadHypothesisId: string;
    readonly intoThreadHypothesisId: string;
    readonly reason: string;
  }[];
  readonly drops: readonly {
    readonly threadHypothesisId: string;
    readonly reason: string;
  }[];
}

function buildPrompt(input: RunForeshadowReconcileTaskInput): string {
  const rows = input.hypothesisSummaries
    .map(
      (row) =>
        `- ${row.threadHypothesisId}: "${row.titleSuggestion}" (setup=${row.setupCount}, payoff=${row.payoffCount})`,
    )
    .join("\n");
  return `あなたは小説の伏線候補グローバル調停アシスタントです。重複候補の統合/除外を JSON で返してください。

# scopeRef
${input.scopeRef}

# hypotheses
${rows}

# 出力（JSON のみ）
{"scopeRef":"${input.scopeRef}","merges":[],"drops":[]}`;
}

function parseResult(
  responseText: string,
  input: RunForeshadowReconcileTaskInput,
): ForeshadowReconcileAiResult | null {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (row.scopeRef !== input.scopeRef) return null;
  const known = new Set(
    input.hypothesisSummaries.map((h) => h.threadHypothesisId),
  );
  const merges = Array.isArray(row.merges)
    ? row.merges.filter((item): item is Record<string, unknown> => {
        if (!item || typeof item !== "object") return false;
        const m = item as Record<string, unknown>;
        return (
          typeof m.fromThreadHypothesisId === "string" &&
          typeof m.intoThreadHypothesisId === "string" &&
          typeof m.reason === "string" &&
          known.has(m.fromThreadHypothesisId) &&
          known.has(m.intoThreadHypothesisId)
        );
      })
    : [];
  const drops = Array.isArray(row.drops)
    ? row.drops.filter((item): item is Record<string, unknown> => {
        if (!item || typeof item !== "object") return false;
        const d = item as Record<string, unknown>;
        return (
          typeof d.threadHypothesisId === "string" &&
          typeof d.reason === "string" &&
          known.has(d.threadHypothesisId)
        );
      })
    : [];
  return {
    scopeRef: input.scopeRef,
    merges: merges.map((m) => ({
      fromThreadHypothesisId: String(m.fromThreadHypothesisId),
      intoThreadHypothesisId: String(m.intoThreadHypothesisId),
      reason: String(m.reason),
    })),
    drops: drops.map((d) => ({
      threadHypothesisId: String(d.threadHypothesisId),
      reason: String(d.reason),
    })),
  };
}

/** Stage AI: narrative_foreshadow_global_reconcile */
export async function runForeshadowReconcileTask(
  input: RunForeshadowReconcileTaskInput,
): Promise<ForeshadowReconcileAiResult | null> {
  if (blockIfPolicyOff("analysis")) return null;
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(NARRATIVE_FORESHADOW_GLOBAL_RECONCILE_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: buildPrompt(input) }],
    {
      projectId,
      pathId: "narrative_foreshadow_global_reconcile",
    },
    undefined,
    undefined,
    ov.apiVariant,
    undefined,
    ov.model,
    ov.provider,
    ov.endpointId,
  );
  void recordAiUsage({
    surface: NARRATIVE_FORESHADOW_GLOBAL_RECONCILE_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_FORESHADOW_GLOBAL_RECONCILE_PATH },
  });

  let parsed = parseResult(response.text, input);
  if (parsed === null && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape: `{"scopeRef":"${input.scopeRef}","merges":[],"drops":[]}`,
      projectId,
    });
    if (repaired) parsed = parseResult(repaired, input);
  }
  return parsed;
}
