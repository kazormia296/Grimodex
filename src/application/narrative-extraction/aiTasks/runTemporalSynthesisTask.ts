import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { validateAttachmentNodeRefs } from "@/features/chronicle/extraction/attachmentCandidates";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_TEMPORAL_SYNTHESIZE_PATH =
  "narrative_temporal_synthesize" as const;

export interface RunTemporalSynthesisTaskInput {
  readonly windowRef: string;
  readonly expressionSummaries: readonly {
    readonly expressionRef: string;
    readonly surface: string;
  }[];
  readonly candidateNodeRefs: readonly string[];
  readonly projectId?: string | null;
  readonly repairOnFailure?: boolean;
}

export interface TemporalRelationAiRow {
  readonly leftRef: string;
  readonly rightRef: string;
  readonly relation:
    | "before"
    | "before-or-equal"
    | "after"
    | "after-or-equal"
    | "meets"
    | "overlaps"
    | "during"
    | "contains"
    | "starts"
    | "finishes"
    | "equals";
  readonly offsetDays: number | null;
}

function buildPrompt(input: RunTemporalSynthesisTaskInput): string {
  const expressions = input.expressionSummaries
    .map((row) => `- ${row.expressionRef}: ${row.surface}`)
    .join("\n");
  const candidates = input.candidateNodeRefs.map((ref) => `- ${ref}`).join("\n");
  return `あなたは小説の時間関係推論アシスタントです。明示された時間関係だけを JSON で返してください。
暦計算・epoch day・実 Scene/Event ID は出力しないでください。候補 Node Ref のみを使います。

# windowRef
${input.windowRef}

# expressions
${expressions}

# candidateNodeRefs
${candidates}

# 出力（JSON のみ）
{"relations":[{"leftRef":"T001","rightRef":"T002","relation":"after","offsetDays":3}]}`;
}

function parseResult(
  responseText: string,
  input: RunTemporalSynthesisTaskInput,
): readonly TemporalRelationAiRow[] | null {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const relations = (parsed as { relations?: unknown }).relations;
  if (!Array.isArray(relations)) return null;
  const catalog = new Set(input.candidateNodeRefs);
  const out: TemporalRelationAiRow[] = [];
  for (const row of relations) {
    if (!row || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    if (typeof r.leftRef !== "string" || typeof r.rightRef !== "string") {
      return null;
    }
    const validated = validateAttachmentNodeRefs(
      [r.leftRef, r.rightRef],
      catalog,
    );
    if (!validated.ok) return null;
    if (typeof r.relation !== "string") return null;
    out.push({
      leftRef: r.leftRef,
      rightRef: r.rightRef,
      relation: r.relation as TemporalRelationAiRow["relation"],
      offsetDays: typeof r.offsetDays === "number" ? r.offsetDays : null,
    });
  }
  return out;
}

export async function runTemporalSynthesisTask(
  input: RunTemporalSynthesisTaskInput,
): Promise<readonly TemporalRelationAiRow[] | null> {
  if (blockIfPolicyOff("analysis")) return null;
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(NARRATIVE_TEMPORAL_SYNTHESIZE_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: buildPrompt(input) }],
    {
      projectId,
      pathId: "narrative_temporal_synthesize",
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
    surface: NARRATIVE_TEMPORAL_SYNTHESIZE_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_TEMPORAL_SYNTHESIZE_PATH },
  });

  let parsed = parseResult(response.text, input);
  if (parsed === null && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape: `{"relations":[{"leftRef":"T001","rightRef":"T002","relation":"after","offsetDays":3}]}`,
      projectId,
    });
    if (repaired) parsed = parseResult(repaired, input);
  }
  return parsed;
}
