import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import type { ImportDocumentPartitionProposal } from "@/features/import/adapters/generic/documentPartition";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const GENERIC_IMPORT_DOCUMENT_PARTITION_PATH =
  "generic_import_document_partition" as const;

export interface RunGenericImportDocumentPartitionTaskInput {
  readonly resourceKey: string;
  readonly relativePath: string;
  readonly blockSummaries: readonly { blockId: string; preview: string }[];
  readonly projectId?: string | null;
  readonly repairOnFailure?: boolean;
}

export function buildGenericImportDocumentPartitionPrompt(
  input: RunGenericImportDocumentPartitionTaskInput,
): string {
  const blocks = input.blockSummaries
    .map((block) => `- ${block.blockId}: ${block.preview.slice(0, 120)}`)
    .join("\n");
  return `あなたは長文原稿の章・場面分割アシスタントです。blockId 一覧から segments を JSON で提案してください。

# resourceKey=${input.resourceKey}
# path=${input.relativePath}

# blocks
${blocks}

# 出力（JSON のみ）
{"resourceKey":"${input.resourceKey}","relativePath":"${input.relativePath}","segments":[{"segmentId":"seg-1","title":"Opening","blockIds":["..."]}]}`;
}

export async function runGenericImportDocumentPartitionTask(
  input: RunGenericImportDocumentPartitionTaskInput,
): Promise<ImportDocumentPartitionProposal | null> {
  if (blockIfPolicyOff("analysis")) return null;

  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(GENERIC_IMPORT_DOCUMENT_PARTITION_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: buildGenericImportDocumentPartitionPrompt(input) }],
    { projectId, pathId: "generic_import_document_partition" },
    undefined,
    undefined,
    ov.apiVariant,
    undefined,
    ov.model,
    ov.provider,
    ov.endpointId,
  );
  void recordAiUsage({
    surface: GENERIC_IMPORT_DOCUMENT_PARTITION_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: GENERIC_IMPORT_DOCUMENT_PARTITION_PATH },
  });

  let parsed = parsePartitionProposal(response.text);
  if (!parsed && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape:
        '{"resourceKey":"string","relativePath":"string","segments":[{"segmentId":"string","title":"string","blockIds":["string"]}]}',
      projectId,
    });
    if (repaired) parsed = parsePartitionProposal(repaired);
  }
  return parsed;
}

function parsePartitionProposal(text: string): ImportDocumentPartitionProposal | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as ImportDocumentPartitionProposal;
    if (!parsed.resourceKey || !Array.isArray(parsed.segments)) return null;
    return parsed;
  } catch {
    return null;
  }
}
