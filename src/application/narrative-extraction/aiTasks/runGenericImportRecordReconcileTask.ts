import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const GENERIC_IMPORT_RECORD_RECONCILE_PATH =
  "generic_import_record_reconcile" as const;

export interface GenericImportRecordCandidate {
  readonly candidateId: string;
  readonly name: string;
  readonly sourceKey: string;
}

export interface GenericImportRecordReconcileResult {
  readonly groups: readonly {
    readonly canonicalId: string;
    readonly memberIds: readonly string[];
  }[];
}

export interface RunGenericImportRecordReconcileTaskInput {
  readonly candidates: readonly GenericImportRecordCandidate[];
  readonly projectId?: string | null;
  readonly repairOnFailure?: boolean;
}

export function buildGenericImportRecordReconcilePrompt(
  candidates: readonly GenericImportRecordCandidate[],
): string {
  const rows = candidates
    .map(
      (candidate) =>
        `- ${candidate.candidateId} name=${candidate.name} source=${candidate.sourceKey}`,
    )
    .join("\n");
  return `あなたはインポート構造レコードの重複統合アシスタントです。同一エンティティ候補を JSON でグループ化してください。

# candidates
${rows}

# 出力（JSON のみ）
{"groups":[{"canonicalId":"c1","memberIds":["c1","c2"]}]}`;
}

export async function runGenericImportRecordReconcileTask(
  input: RunGenericImportRecordReconcileTaskInput,
): Promise<GenericImportRecordReconcileResult | null> {
  if (blockIfPolicyOff("analysis")) return null;
  if (input.candidates.length === 0) return { groups: [] };

  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(GENERIC_IMPORT_RECORD_RECONCILE_PATH);
  const response = await sendChatMessageWithThinking(
    [
      {
        role: "user",
        content: buildGenericImportRecordReconcilePrompt(input.candidates),
      },
    ],
    { projectId, pathId: "generic_import_record_reconcile" },
    undefined,
    undefined,
    ov.apiVariant,
    undefined,
    ov.model,
    ov.provider,
    ov.endpointId,
  );
  void recordAiUsage({
    surface: GENERIC_IMPORT_RECORD_RECONCILE_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: GENERIC_IMPORT_RECORD_RECONCILE_PATH },
  });

  let parsed = parseReconcileResult(response.text);
  if (!parsed && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape:
        '{"groups":[{"canonicalId":"string","memberIds":["string"]}]}',
      projectId,
    });
    if (repaired) parsed = parseReconcileResult(repaired);
  }
  return parsed;
}

function parseReconcileResult(
  text: string,
): GenericImportRecordReconcileResult | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as GenericImportRecordReconcileResult;
    if (!Array.isArray(parsed.groups)) return null;
    return parsed;
  } catch {
    return null;
  }
}
