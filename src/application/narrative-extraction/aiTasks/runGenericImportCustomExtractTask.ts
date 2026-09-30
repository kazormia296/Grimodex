import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockNarrativeAiTask } from "./narrativeAiTaskGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import type { GenericExtractionSchema } from "@/features/import/generic-schema/schemaTypes";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const GENERIC_IMPORT_CUSTOM_EXTRACT_PATH =
  "generic_import_custom_extract" as const;

export interface RunGenericImportCustomExtractTaskInput {
  readonly schema: GenericExtractionSchema;
  readonly tablePreview: string;
  readonly projectId?: string | null;
  readonly repairOnFailure?: boolean;
}

export function buildGenericImportCustomExtractPrompt(
  input: RunGenericImportCustomExtractTaskInput,
): string {
  return `あなたはカスタム抽出スキーマに従い、表形式データから構造化レコードを JSON で抽出するアシスタントです。

# schema
${JSON.stringify(input.schema, null, 2)}

# tablePreview
${input.tablePreview}

# 出力（JSON のみ）
{"records":[{"recordId":"character","rows":[{"name":"..."}]}]}`;
}

export async function runGenericImportCustomExtractTask(
  input: RunGenericImportCustomExtractTaskInput,
): Promise<unknown | null> {
  if (blockNarrativeAiTask()) return null;

  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(GENERIC_IMPORT_CUSTOM_EXTRACT_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: buildGenericImportCustomExtractPrompt(input) }],
    { projectId, pathId: "generic_import_custom_extract" },
    undefined,
    undefined,
    ov.apiVariant,
    undefined,
    ov.model,
    ov.provider,
    ov.endpointId,
  );
  void recordAiUsage({
    surface: GENERIC_IMPORT_CUSTOM_EXTRACT_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: GENERIC_IMPORT_CUSTOM_EXTRACT_PATH },
  });

  let parsed = parseJsonPayload(response.text);
  if (!parsed && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape: '{"records":[{"recordId":"string","rows":[{}]}]}',
      projectId,
    });
    if (repaired) parsed = parseJsonPayload(repaired);
  }
  return parsed;
}

function parseJsonPayload(text: string): unknown | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}
