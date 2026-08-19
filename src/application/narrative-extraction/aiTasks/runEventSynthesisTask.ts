import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockNarrativeAiTask } from "./narrativeAiTaskGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { normalizeEventSynthesis } from "@/features/chronicle/extraction/eventSynthesis";
import { parseRawEventSynthesisResult } from "@/features/chronicle/extraction/schemas";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_EVENT_SYNTHESIZE_PATH =
  "narrative_event_synthesize" as const;

export type EventSynthesisSend = (
  messages: Parameters<typeof sendChatMessageWithThinking>[0],
  options: Parameters<typeof sendChatMessageWithThinking>[1],
) => Promise<
  Pick<
    Awaited<ReturnType<typeof sendChatMessageWithThinking>>,
    "text" | "inputTokens" | "outputTokens"
  >
>;

export interface RunEventSynthesisTaskInput {
  readonly clusterRef: string;
  readonly observations: readonly RawChronicleEventObservation[];
  readonly projectId?: string | null;
  readonly createId?: () => string;
  readonly repairOnFailure?: boolean;
  readonly onParseStatus?: (status: "parsed" | "invalid") => void;
  /** Live eval / tests may inject OpenRouter (or other) transport. */
  readonly send?: EventSynthesisSend;
}

function buildSynthesisPrompt(input: RunEventSynthesisTaskInput): string {
  const rows = input.observations
    .map((observation) => {
      const quotes = observation.evidence
        .map((item) => `${item.sourceRef}:${item.quote}`)
        .join(" | ");
      return `- localId=${observation.localId}; actuality=${observation.payload.actuality}; predicate=${observation.payload.predicate}; evidence=${quotes}`;
    })
    .join("\n");
  return `あなたは小説の出来事統合アシスタントです。同一候補 Cluster 内の Observation を評価し、Event Hypothesis を JSON で返してください。
本文全量は再送しません。Observation Ref と短い Evidence 表示だけを使います。未知の Observation Ref は出力しないでください。

# clusterRef
${input.clusterRef}

# Observations
${rows}

# 出力（JSON のみ）
{"clusterRef":"${input.clusterRef}","resolution":"single-event","events":[{"observationRefs":["obs-1"],"titleSuggestion":"短いタイトル","summary":"要約","actuality":"actual","significance":"major"}]}`;
}

async function parseSynthesisFromText(
  responseText: string,
  input: RunEventSynthesisTaskInput,
): Promise<{
  readonly hypotheses: readonly EventHypothesis[];
  readonly status: "parsed" | "invalid";
} | null> {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const allowedObservationRefs = new Set(
    input.observations.map((observation) => observation.localId),
  );
  return {
    hypotheses: normalizeEventSynthesis(parsed, {
      clusterRef: input.clusterRef,
      allowedObservationRefs,
      createId: input.createId,
    }),
    status: parseRawEventSynthesisResult(parsed).ok ? "parsed" : "invalid",
  };
}

/**
 * Stage AI: narrative_event_synthesize.
 * Receives observation refs + short evidence display only (no DB ids).
 */
export async function runEventSynthesisTask(
  input: RunEventSynthesisTaskInput,
): Promise<readonly EventHypothesis[]> {
  if (blockNarrativeAiTask()) return [];
  if (input.observations.length === 0) return [];

  const prompt = buildSynthesisPrompt(input);
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride("narrative_event_synthesize");
  const response = input.send
    ? await input.send([{ role: "user", content: prompt }], {
        projectId,
        pathId: "narrative_event_synthesize",
      })
    : await sendChatMessageWithThinking(
        [{ role: "user", content: prompt }],
        {
          projectId,
          pathId: "narrative_event_synthesize",
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
    surface: "narrative_event_synthesize",
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_EVENT_SYNTHESIZE_PATH },
  });

  const first = await parseSynthesisFromText(response.text, input);
  if (first !== null) {
    input.onParseStatus?.(first.status);
    return first.hypotheses;
  }
  if (input.repairOnFailure === false) {
    input.onParseStatus?.("invalid");
    return [];
  }

  const repaired = await runStructuredRepairTask({
    brokenText: response.text,
    expectedShape: `{"clusterRef":"${input.clusterRef}","resolution":"single-event","events":[{"observationRefs":["obs-1"],"titleSuggestion":"t","summary":"s","actuality":"actual","significance":"major"}]}`,
    projectId,
  });
  if (!repaired) {
    input.onParseStatus?.("invalid");
    return [];
  }
  const parsed = await parseSynthesisFromText(repaired, input);
  input.onParseStatus?.(parsed?.status ?? "invalid");
  return parsed?.hypotheses ?? [];
}
