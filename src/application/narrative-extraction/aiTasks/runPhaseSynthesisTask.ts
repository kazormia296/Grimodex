import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockNarrativeAiTask } from "./narrativeAiTaskGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import type { PhaseBoundaryHypothesis } from "@/features/narrative-extraction/ir/inferences/phaseBoundary";
import type { PhaseBoundaryCandidate } from "@/features/codex/extraction/phaseBoundaryCandidates";
import { synthesizePhaseBoundaries } from "@/features/codex/extraction/phaseBoundarySynthesis";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_PHASE_SYNTHESIZE_PATH =
  "narrative_phase_synthesize" as const;

export interface RunPhaseSynthesisTaskInput {
  readonly candidate: PhaseBoundaryCandidate;
  readonly projectId?: string | null;
  readonly createId?: () => string;
  readonly repairOnFailure?: boolean;
}

function buildPrompt(input: RunPhaseSynthesisTaskInput): string {
  const facets = input.candidate.transitions
    .map(
      (t) =>
        `- ${t.transitionId}: facet=${t.payload.facetKey}; durability=${t.payload.durability}; retrospective=${t.payload.retrospectiveOnly}`,
    )
    .join("\n");
  return `あなたは小説の Phase 境界推論アシスタントです。同一 Entity / Scene アンカーの durable 状態変化を評価し、Phase label 提案を JSON で返してください。
一時的な感情・場所移動は Phase にしません。実 Codex Entry / Phase ID は出力しないでください。

# entityId
${input.candidate.entityId}

# anchorDocumentRef
${input.candidate.anchorDocumentRef}

# transitions
${facets}

# 出力（JSON のみ）
{"entityId":"${input.candidate.entityId}","anchorDocumentRef":"${input.candidate.anchorDocumentRef}","labelSuggestion":"負傷後"}`;
}

function applyLabel(
  boundaries: readonly PhaseBoundaryHypothesis[],
  labelSuggestion: string | null,
): readonly PhaseBoundaryHypothesis[] {
  if (!labelSuggestion) return boundaries;
  return boundaries.map((boundary) => ({
    ...boundary,
    payload: {
      ...boundary.payload,
      labelSuggestion,
    },
  }));
}

/**
 * Stage AI: narrative_phase_synthesize.
 * Persistence gate remains deterministic; AI may only suggest labels.
 */
export async function runPhaseSynthesisTask(
  input: RunPhaseSynthesisTaskInput,
): Promise<readonly PhaseBoundaryHypothesis[]> {
  const createId = input.createId ?? (() => crypto.randomUUID());
  const deterministic = synthesizePhaseBoundaries([input.candidate], {
    createId,
  });
  if (blockNarrativeAiTask()) return deterministic;

  const prompt = buildPrompt(input);
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(NARRATIVE_PHASE_SYNTHESIZE_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: prompt }],
    {
      projectId,
      pathId: "narrative_phase_synthesize",
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
    surface: NARRATIVE_PHASE_SYNTHESIZE_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_PHASE_SYNTHESIZE_PATH },
  });

  const parseLabel = (text: string): string | null => {
    const jsonText = extractJsonObject(text);
    if (!jsonText) return null;
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      if (parsed.entityId !== input.candidate.entityId) return null;
      if (parsed.anchorDocumentRef !== input.candidate.anchorDocumentRef) {
        return null;
      }
      return typeof parsed.labelSuggestion === "string"
        ? parsed.labelSuggestion.trim() || null
        : null;
    } catch {
      return null;
    }
  };

  let label = parseLabel(response.text);
  if (label === null && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape: `{"entityId":"${input.candidate.entityId}","anchorDocumentRef":"${input.candidate.anchorDocumentRef}","labelSuggestion":"負傷後"}`,
      projectId,
    });
    if (repaired) label = parseLabel(repaired);
  }

  return applyLabel(deterministic, label);
}
