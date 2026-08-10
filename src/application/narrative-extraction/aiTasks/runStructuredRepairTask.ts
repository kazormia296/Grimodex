import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";

export const NARRATIVE_STRUCTURED_REPAIR_PATH =
  "narrative_structured_repair" as const;

export interface RunStructuredRepairTaskInput {
  readonly brokenText: string;
  readonly expectedShape: string;
  readonly projectId?: string | null;
}

/**
 * Stage AI: narrative_structured_repair.
 * Called at most once after a JSON extract/parse failure on another stage.
 */
export async function runStructuredRepairTask(
  input: RunStructuredRepairTaskInput,
): Promise<string | null> {
  if (blockIfPolicyOff("analysis")) return null;

  const prompt = `次のモデル出力を、指定の JSON 形へ修復してください。説明文は付けず JSON だけを返します。
Project ID / Scene ID / Event ID などの DB 識別子は新たに作らず、入力に含まれる Source View ref（S0001 形式）だけを維持してください。

# 期待する形
${input.expectedShape}

# 壊れた出力
${input.brokenText}`;

  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride("narrative_structured_repair");
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: prompt }],
    {
      projectId,
      pathId: "narrative_structured_repair",
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
    surface: "chronicle_extract",
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_STRUCTURED_REPAIR_PATH },
  });

  return extractJsonObject(response.text);
}
