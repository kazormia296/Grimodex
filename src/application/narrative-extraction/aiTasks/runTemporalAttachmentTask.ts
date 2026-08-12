import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { validateAttachmentNodeRefs } from "@/features/chronicle/extraction/attachmentCandidates";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_TEMPORAL_ATTACH_PATH =
  "narrative_temporal_attach" as const;

export interface RunTemporalAttachmentTaskInput {
  readonly expressionRef: string;
  readonly surface: string;
  readonly candidateNodeRefs: readonly string[];
  readonly projectId?: string | null;
  readonly repairOnFailure?: boolean;
}

export interface TemporalAttachmentAiResult {
  readonly expressionRef: string;
  readonly targetRef: string | null;
  readonly anchorRef: string | null;
  readonly role:
    | "occurs-at"
    | "starts-at"
    | "ends-at"
    | "duration"
    | "relative-to";
}

function buildPrompt(input: RunTemporalAttachmentTaskInput): string {
  const candidates = input.candidateNodeRefs
    .map((ref) => `- ${ref}`)
    .join("\n");
  return `あなたは小説の時間表現 Attachment アシスタントです。時間表現がどの Temporal Node に掛かるかを JSON で返してください。
候補にない Node Ref は絶対に作らないでください。実 Scene / Event / DB ID は使いません。

# expressionRef
${input.expressionRef}

# surface
${input.surface}

# candidateNodeRefs
${candidates}

# 出力（JSON のみ）
{"expressionRef":"${input.expressionRef}","targetRef":"T001","anchorRef":"T002","role":"relative-to"}`;
}

function parseResult(
  responseText: string,
  input: RunTemporalAttachmentTaskInput,
): TemporalAttachmentAiResult | null {
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
  if (row.expressionRef !== input.expressionRef) return null;
  const catalog = new Set(input.candidateNodeRefs);
  const refs = [row.targetRef, row.anchorRef].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const validated = validateAttachmentNodeRefs(refs, catalog);
  if (!validated.ok) return null;
  const role = row.role;
  if (
    role !== "occurs-at" &&
    role !== "starts-at" &&
    role !== "ends-at" &&
    role !== "duration" &&
    role !== "relative-to"
  ) {
    return null;
  }
  return {
    expressionRef: input.expressionRef,
    targetRef: typeof row.targetRef === "string" ? row.targetRef : null,
    anchorRef: typeof row.anchorRef === "string" ? row.anchorRef : null,
    role,
  };
}

export async function runTemporalAttachmentTask(
  input: RunTemporalAttachmentTaskInput,
): Promise<TemporalAttachmentAiResult | null> {
  if (blockIfPolicyOff("analysis")) return null;
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(NARRATIVE_TEMPORAL_ATTACH_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: buildPrompt(input) }],
    {
      projectId,
      pathId: "narrative_temporal_attach",
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
    surface: NARRATIVE_TEMPORAL_ATTACH_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_TEMPORAL_ATTACH_PATH },
  });

  let parsed = parseResult(response.text, input);
  if (parsed === null && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape: `{"expressionRef":"...","targetRef":"T001","anchorRef":"T002","role":"relative-to"}`,
      projectId,
    });
    if (repaired) parsed = parseResult(repaired, input);
  }
  return parsed;
}
