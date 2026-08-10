import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import type { StateTrackHypothesis } from "@/features/narrative-extraction/ir/inferences/stateTrack";
import type { StateTrackManifestEntry } from "@/features/codex/extraction/stateTrackManifest";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_STATE_SYNTHESIZE_PATH =
  "narrative_state_synthesize" as const;

export interface RunStateSynthesisTaskInput {
  readonly manifest: StateTrackManifestEntry;
  readonly observationSummaries: readonly {
    readonly observationId: string;
    readonly facetKey: string;
    readonly valueSummary: string;
    readonly temporalMode: string;
  }[];
  readonly projectId?: string | null;
  readonly createId?: () => string;
  readonly repairOnFailure?: boolean;
  /**
   * Deterministic fallback used when AI is off / fails.
   * Callers typically pass synthesizeStateTracks for this manifest row.
   */
  readonly deterministicFallback?: () => readonly StateTrackHypothesis[];
}

function buildPrompt(input: RunStateSynthesisTaskInput): string {
  const observations = input.observationSummaries
    .map(
      (row) =>
        `- ${row.observationId}: facet=${row.facetKey}; value=${row.valueSummary}; temporal=${row.temporalMode}`,
    )
    .join("\n");
  return `あなたは小説の状態トラック推論アシスタントです。同一 Entity / facet の State Assertion を統合し、State Track Hypothesis を JSON で返してください。
実 Codex Entry ID は出力しないでください。Narrative Entity ID のみを使います。

# entityId
${input.manifest.entityId}

# facetKey
${input.manifest.facetKey}

# observations
${observations}

# 出力（JSON のみ）
{"entityId":"${input.manifest.entityId}","facetKey":"${input.manifest.facetKey}","points":[{"observationId":"obs-1","valueKind":"text","text":"傷を負った","temporalMode":"current","retrospectiveOnly":false}]}`;
}

function parseAiTracks(
  responseText: string,
  input: RunStateSynthesisTaskInput,
): readonly StateTrackHypothesis[] | null {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (row.entityId !== input.manifest.entityId) return null;
  if (row.facetKey !== input.manifest.facetKey) return null;
  // AI enrichment is optional in PR3; accept shape and fall back to deterministic.
  return input.deterministicFallback?.() ?? null;
}

/**
 * Stage AI: narrative_state_synthesize.
 * Prefer deterministic synthesis; AI may enrich when available.
 */
export async function runStateSynthesisTask(
  input: RunStateSynthesisTaskInput,
): Promise<readonly StateTrackHypothesis[]> {
  const fallback = input.deterministicFallback?.() ?? [];
  if (blockIfPolicyOff("analysis")) return fallback;
  if (input.observationSummaries.length === 0) return fallback;

  const prompt = buildPrompt(input);
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(NARRATIVE_STATE_SYNTHESIZE_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: prompt }],
    {
      projectId,
      pathId: "narrative_state_synthesize",
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
    surface: NARRATIVE_STATE_SYNTHESIZE_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_STATE_SYNTHESIZE_PATH },
  });

  const first = parseAiTracks(response.text, input);
  if (first !== null) return first;
  if (input.repairOnFailure === false) return fallback;

  const repaired = await runStructuredRepairTask({
    brokenText: response.text,
    expectedShape: `{"entityId":"${input.manifest.entityId}","facetKey":"${input.manifest.facetKey}","points":[{"observationId":"obs-1","valueKind":"text","text":"...","temporalMode":"current","retrospectiveOnly":false}]}`,
    projectId,
  });
  const second = repaired ? parseAiTracks(repaired, input) : null;
  return second ?? fallback;
}
