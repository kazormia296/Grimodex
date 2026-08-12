import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_FORESHADOW_QUALITY_EVALUATE_PATH =
  "narrative_foreshadow_quality_evaluate" as const;

export interface RunForeshadowQualityTaskInput {
  readonly threadHypothesisId: string;
  readonly titleSuggestion: string;
  readonly setupExcerpt: string;
  readonly payoffExcerpt: string | null;
  readonly loadBearing: "critical" | "supporting" | "optional" | null;
  readonly projectId?: string | null;
  readonly repairOnFailure?: boolean;
}

export interface ForeshadowQualityAiResult {
  readonly threadHypothesisId: string;
  readonly anyWeak: boolean;
  readonly predictedStrength: "subtle" | "moderate" | "overt";
  readonly qualityIssue: "too-subtle" | "needs-strengthening" | "none";
  readonly rationale: string;
}

function buildPrompt(input: RunForeshadowQualityTaskInput): string {
  return `あなたは小説の伏線 setup 強度評価アシスタントです。setup 抜粋の読み取りやすさを JSON で返してください。

# threadHypothesisId
${input.threadHypothesisId}

# titleSuggestion
${input.titleSuggestion}

# loadBearing
${input.loadBearing ?? "null"}

# setupExcerpt
${input.setupExcerpt}

# payoffExcerpt
${input.payoffExcerpt ?? "(none)"}

# 出力（JSON のみ）
{"threadHypothesisId":"${input.threadHypothesisId}","anyWeak":false,"predictedStrength":"moderate","qualityIssue":"none","rationale":"..."}`;
}

function parseResult(
  responseText: string,
  input: RunForeshadowQualityTaskInput,
): ForeshadowQualityAiResult | null {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const row = parsed as Record<string, unknown>;
  if (row.threadHypothesisId !== input.threadHypothesisId) return null;
  if (typeof row.anyWeak !== "boolean") return null;
  const predictedStrength = row.predictedStrength;
  if (
    predictedStrength !== "subtle" &&
    predictedStrength !== "moderate" &&
    predictedStrength !== "overt"
  ) {
    return null;
  }
  const qualityIssue = row.qualityIssue;
  if (
    qualityIssue !== "too-subtle" &&
    qualityIssue !== "needs-strengthening" &&
    qualityIssue !== "none"
  ) {
    return null;
  }
  if (typeof row.rationale !== "string") return null;
  return {
    threadHypothesisId: input.threadHypothesisId,
    anyWeak: row.anyWeak,
    predictedStrength,
    qualityIssue,
    rationale: row.rationale.trim(),
  };
}

/** Stage AI: narrative_foreshadow_quality_evaluate */
export async function runForeshadowQualityTask(
  input: RunForeshadowQualityTaskInput,
): Promise<ForeshadowQualityAiResult | null> {
  if (blockIfPolicyOff("analysis")) return null;
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(
    NARRATIVE_FORESHADOW_QUALITY_EVALUATE_PATH,
  );
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: buildPrompt(input) }],
    {
      projectId,
      pathId: "narrative_foreshadow_quality_evaluate",
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
    surface: NARRATIVE_FORESHADOW_QUALITY_EVALUATE_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_FORESHADOW_QUALITY_EVALUATE_PATH },
  });

  let parsed = parseResult(response.text, input);
  if (parsed === null && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape: `{"threadHypothesisId":"${input.threadHypothesisId}","anyWeak":false,"predictedStrength":"moderate","qualityIssue":"none","rationale":"..."}`,
      projectId,
    });
    if (repaired) parsed = parseResult(repaired, input);
  }
  return parsed;
}
