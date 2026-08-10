import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { validateAttachmentNodeRefs } from "@/features/chronicle/extraction/attachmentCandidates";
import type { PlotThreadCore } from "@/features/narrative-extraction/ir/inferences/plotThreadHypothesis";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_PLOT_THREAD_SYNTHESIZE_PATH =
  "narrative_plot_thread_synthesize" as const;

const CORE_KINDS: readonly PlotThreadCore["kind"][] = [
  "goal-pursuit",
  "conflict",
  "open-question",
  "relationship-arc",
  "character-arc",
  "process",
  "composite",
];

export interface RunPlotThreadSynthesisTaskInput {
  readonly clusterRef: string;
  readonly developmentSummaries: readonly {
    readonly developmentInferenceId: string;
    readonly documentRef: string;
    readonly advancement: string;
    readonly explanation: string;
  }[];
  readonly candidateEntityRefs: readonly string[];
  readonly projectId?: string | null;
  readonly repairOnFailure?: boolean;
}

export interface PlotThreadSynthesisAiResult {
  readonly clusterRef: string;
  readonly nameSuggestion: string;
  readonly descriptionSuggestion: string;
  readonly prominence: "primary" | "supporting" | "minor";
  readonly coreKind: PlotThreadCore["kind"];
  readonly participantEntityRefs: readonly string[];
}

function buildPrompt(input: RunPlotThreadSynthesisTaskInput): string {
  const developments = input.developmentSummaries
    .map(
      (row) =>
        `- ${row.developmentInferenceId} @ ${row.documentRef} (${row.advancement}): ${row.explanation}`,
    )
    .join("\n");
  const candidates = input.candidateEntityRefs
    .map((ref) => `- ${ref}`)
    .join("\n");
  return `あなたは小説のプロットスレッド統合アシスタントです。1 クラスタ分の Thread Development から、
1 本のプロットスレッド候補（名前・種類・関与エンティティ）だけを JSON で返してください。
候補にない Entity Ref は絶対に作らないでください。実 Scene / Event / DB ID は使いません。

# clusterRef
${input.clusterRef}

# developments
${developments}

# candidateEntityRefs
${candidates}

# coreKind の選択肢
goal-pursuit, conflict, open-question, relationship-arc, character-arc, process, composite

# 出力（JSON のみ）
{"clusterRef":"${input.clusterRef}","nameSuggestion":"...","descriptionSuggestion":"...","prominence":"supporting","coreKind":"goal-pursuit","participantEntityRefs":["E001"]}`;
}

function parseResult(
  responseText: string,
  input: RunPlotThreadSynthesisTaskInput,
): PlotThreadSynthesisAiResult | null {
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
  if (row.clusterRef !== input.clusterRef) return null;
  if (
    typeof row.nameSuggestion !== "string" ||
    row.nameSuggestion.trim() === ""
  ) {
    return null;
  }
  if (typeof row.descriptionSuggestion !== "string") return null;
  const prominence = row.prominence;
  if (
    prominence !== "primary" &&
    prominence !== "supporting" &&
    prominence !== "minor"
  ) {
    return null;
  }
  const coreKind = row.coreKind;
  if (
    typeof coreKind !== "string" ||
    !CORE_KINDS.includes(coreKind as PlotThreadCore["kind"])
  ) {
    return null;
  }
  const rawRefs = Array.isArray(row.participantEntityRefs)
    ? row.participantEntityRefs.filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  const catalog = new Set(input.candidateEntityRefs);
  const validated = validateAttachmentNodeRefs(rawRefs, catalog);
  if (!validated.ok) return null;
  return {
    clusterRef: input.clusterRef,
    nameSuggestion: row.nameSuggestion.trim(),
    descriptionSuggestion: row.descriptionSuggestion.trim(),
    prominence,
    coreKind: coreKind as PlotThreadCore["kind"],
    participantEntityRefs: rawRefs,
  };
}

/**
 * Stage AI: narrative_plot_thread_synthesize.
 * Synthesizes a single Plot Thread seed (name/kind/participants) from one
 * cluster of Thread Development inferences. The full PlotThreadCore
 * structure is built downstream by the (deterministic) compiler; this task
 * only proposes the coarse identity so hallucinated refs never reach it.
 */
export async function runPlotThreadSynthesisTask(
  input: RunPlotThreadSynthesisTaskInput,
): Promise<PlotThreadSynthesisAiResult | null> {
  if (blockIfPolicyOff("analysis")) return null;
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(NARRATIVE_PLOT_THREAD_SYNTHESIZE_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: buildPrompt(input) }],
    {
      projectId,
      pathId: "narrative_plot_thread_synthesize",
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
    surface: NARRATIVE_PLOT_THREAD_SYNTHESIZE_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_PLOT_THREAD_SYNTHESIZE_PATH },
  });

  let parsed = parseResult(response.text, input);
  if (parsed === null && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape: `{"clusterRef":"${input.clusterRef}","nameSuggestion":"...","descriptionSuggestion":"...","prominence":"supporting","coreKind":"goal-pursuit","participantEntityRefs":["E001"]}`,
      projectId,
    });
    if (repaired) parsed = parseResult(repaired, input);
  }
  return parsed;
}
