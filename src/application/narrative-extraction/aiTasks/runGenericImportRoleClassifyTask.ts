import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import type { ClassificationSample } from "@/features/import/adapters/generic/classificationSample";
import type { GenericImportResourceRole } from "@/features/import/adapters/generic/resourceRole";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const GENERIC_IMPORT_ROLE_CLASSIFY_PATH =
  "generic_import_role_classify" as const;

export interface GenericRoleClassifyAiResult {
  readonly resourceKey: string;
  readonly role: GenericImportResourceRole;
  readonly confidence: number;
}

export interface RunGenericImportRoleClassifyTaskInput {
  readonly samples: readonly ClassificationSample[];
  readonly projectId?: string | null;
  readonly repairOnFailure?: boolean;
}

export function buildGenericImportRoleClassifyPrompt(
  samples: readonly ClassificationSample[],
): string {
  const bodies = samples
    .map(
      (sample) =>
        `--- resourceKey=${sample.resourceKey} path=${sample.relativePath} len=${sample.totalLength} ---\nHEAD:\n${sample.head}\n\nTAIL:\n${sample.tail}`,
    )
    .join("\n\n");
  return `あなたはインポート資源の役割分類アシスタントです。各ファイル断片の semantic role を JSON で返してください。

# Samples
${bodies}

# role 選択肢
manuscript, chapter-index, codex-table, snippet-table, metadata, asset, config, ignore, unknown

# 出力（JSON のみ）
{"assignments":[{"resourceKey":"...","role":"manuscript","confidence":0.9}]}`;
}

export async function runGenericImportRoleClassifyTask(
  input: RunGenericImportRoleClassifyTaskInput,
): Promise<readonly GenericRoleClassifyAiResult[]> {
  if (blockIfPolicyOff("analysis")) return [];
  if (input.samples.length === 0) return [];

  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(GENERIC_IMPORT_ROLE_CLASSIFY_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: buildGenericImportRoleClassifyPrompt(input.samples) }],
    { projectId, pathId: "generic_import_role_classify" },
    undefined,
    undefined,
    ov.apiVariant,
    undefined,
    ov.model,
    ov.provider,
    ov.endpointId,
  );
  void recordAiUsage({
    surface: GENERIC_IMPORT_ROLE_CLASSIFY_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: GENERIC_IMPORT_ROLE_CLASSIFY_PATH },
  });

  let parsed = parseRoleAssignments(response.text);
  if (!parsed && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape:
        '{"assignments":[{"resourceKey":"string","role":"manuscript","confidence":0.9}]}',
      projectId,
    });
    if (repaired) parsed = parseRoleAssignments(repaired);
  }
  return parsed ?? [];
}

function parseRoleAssignments(
  responseText: string,
): readonly GenericRoleClassifyAiResult[] | null {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const assignments = (parsed as { assignments?: unknown }).assignments;
  if (!Array.isArray(assignments)) return null;
  const results: GenericRoleClassifyAiResult[] = [];
  for (const item of assignments) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.resourceKey !== "string" || typeof row.role !== "string") continue;
    results.push({
      resourceKey: row.resourceKey,
      role: row.role as GenericImportResourceRole,
      confidence: typeof row.confidence === "number" ? row.confidence : 0.5,
    });
  }
  return results.length > 0 ? results : null;
}
