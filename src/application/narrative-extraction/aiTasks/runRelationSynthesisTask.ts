import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { normalizeRelationSynthesis } from "@/features/codex/extraction/relationSynthesis";
import type { RelationCandidateIndexEntry } from "@/features/codex/extraction/relationCandidateIndex";
import type { CodexRelationHypothesis } from "@/features/narrative-extraction/ir/inferences/codexRelationHypothesis";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_RELATION_SYNTHESIZE_PATH =
  "narrative_relation_synthesize" as const;

export interface RunRelationSynthesisTaskInput {
  readonly candidate: RelationCandidateIndexEntry;
  readonly projectId?: string | null;
  readonly createId?: () => string;
  readonly repairOnFailure?: boolean;
}

function buildRelationSynthesisPrompt(
  input: RunRelationSynthesisTaskInput,
): string {
  const predicates = input.candidate.predicates.join(" / ");
  const observationRefs = input.candidate.observationIds.join(", ");
  return `あなたは小説の関係推論アシスタントです。候補 Entity ペアの Relation Observation を評価し、Codex Relation Hypothesis を JSON で返してください。
実 Codex Entry ID や Type slug は出力しないでください。Subject/Object は渡された Narrative Entity ID のみを使います。

# candidateRef
${input.candidate.candidateId}

# subjectEntityId
${input.candidate.subjectEntityId}

# objectEntityId
${input.candidate.objectEntityId}

# observationRefs
${observationRefs}

# predicates
${predicates}

# 出力（JSON のみ）
{"candidateRef":"${input.candidate.candidateId}","relations":[{"observationRefs":[${input.candidate.observationIds.map((id) => `"${id}"`).join(",")}],"subjectEntityId":"${input.candidate.subjectEntityId}","objectEntityId":"${input.candidate.objectEntityId}","predicate":"友人","family":"social","validity":"current","directionality":"symmetric","forwardLabelSuggestion":"友人","inverseLabelSuggestion":"友人","polarity":"affirmed","commitment":"story-fact","support":"direct","narrativeFrame":"primary"}]}`;
}

async function parseRelationSynthesisFromText(
  responseText: string,
  input: RunRelationSynthesisTaskInput,
): Promise<readonly CodexRelationHypothesis[] | null> {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  return normalizeRelationSynthesis(parsed, {
    candidateRef: input.candidate.candidateId,
    allowedObservationRefs: new Set(input.candidate.observationIds),
    resolvedEntityIds: new Set([
      input.candidate.subjectEntityId,
      input.candidate.objectEntityId,
    ]),
    createId: input.createId,
  });
}

/**
 * Stage AI: narrative_relation_synthesize.
 * Receives candidate entity ids (opaque narrative ids) + observation refs only.
 */
export async function runRelationSynthesisTask(
  input: RunRelationSynthesisTaskInput,
): Promise<readonly CodexRelationHypothesis[]> {
  if (blockIfPolicyOff("analysis")) return [];
  if (input.candidate.observationIds.length === 0) return [];

  const prompt = buildRelationSynthesisPrompt(input);
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(NARRATIVE_RELATION_SYNTHESIZE_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: prompt }],
    {
      projectId,
      pathId: "narrative_relation_synthesize",
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
    surface: "narrative_relation_synthesize",
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_RELATION_SYNTHESIZE_PATH },
  });

  const first = await parseRelationSynthesisFromText(response.text, input);
  if (first !== null) return first;
  if (input.repairOnFailure === false) return [];

  const repaired = await runStructuredRepairTask({
    brokenText: response.text,
    expectedShape: `{"candidateRef":"${input.candidate.candidateId}","relations":[{"observationRefs":["obs-1"],"subjectEntityId":"e1","objectEntityId":"e2","predicate":"友人","family":"social","validity":"current","directionality":"symmetric","forwardLabelSuggestion":"友人","inverseLabelSuggestion":"友人","polarity":"affirmed","commitment":"story-fact","support":"direct","narrativeFrame":"primary"}]}`,
    projectId,
  });
  if (!repaired) return [];
  return (await parseRelationSynthesisFromText(repaired, input)) ?? [];
}
