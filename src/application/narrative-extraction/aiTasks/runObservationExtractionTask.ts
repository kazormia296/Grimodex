import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { normalizeWindowObservations } from "@/features/chronicle/extraction/windowExtractor";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_OBSERVATION_EXTRACT_PATH =
  "narrative_observation_extract" as const;

export interface ObservationExtractionWindowInput {
  readonly sourceRef: string;
  readonly text: string;
}

export type ObservationExtractionSend = (
  messages: Parameters<typeof sendChatMessageWithThinking>[0],
  options: Parameters<typeof sendChatMessageWithThinking>[1],
) => Promise<
  Pick<
    Awaited<ReturnType<typeof sendChatMessageWithThinking>>,
    "text" | "inputTokens" | "outputTokens"
  >
>;

export interface RunObservationExtractionTaskInput {
  readonly windows: readonly ObservationExtractionWindowInput[];
  readonly projectId?: string | null;
  readonly createId?: () => string;
  readonly repairOnFailure?: boolean;
  /** Live eval / tests may inject OpenRouter (or other) transport. */
  readonly send?: ObservationExtractionSend;
}

/** Production observation prompt (shared with live eval certification). */
export function buildObservationExtractionPrompt(
  windows: readonly ObservationExtractionWindowInput[],
): string {
  const bodies = windows
    .map(
      (window) =>
        `--- sourceRef=${window.sourceRef} ---\n${window.text}`,
    )
    .join("\n\n");
  return `あなたは小説本文の観測アシスタントです。与えられた Source View 断片から、作中で提示されている出来事の Observation を JSON で列挙してください。
Project ID / Scene ID / Event ID / DB version は出力にも入力にも使いません。evidence.sourceRef には与えた sourceRef（例: S0001）だけを使います。

# Source Views
${bodies}

# 出力（JSON のみ）
{"observations":[{"localId":"obs-1","evidence":[{"sourceRef":"S0001","quote":"原文の完全一致引用"}],"assertion":{"attribution":"narrator","narrativeFrame":"story-world"},"payload":{"predicate":"出来事の述語","actuality":"actual","participants":[],"temporalExpressions":[],"durationKind":"instant"}}]}`;
}

async function parseObservationsFromText(
  responseText: string,
  allowedSourceRefs: ReadonlySet<string>,
  createId?: () => string,
): Promise<readonly RawChronicleEventObservation[] | null> {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  return normalizeWindowObservations(parsed, {
    allowedSourceRefs,
    createId,
  });
}

/**
 * Stage AI: narrative_observation_extract.
 * Passes only Source View refs (S0001…) — never project/scene/event DB ids.
 */
export async function runObservationExtractionTask(
  input: RunObservationExtractionTaskInput,
): Promise<readonly RawChronicleEventObservation[]> {
  if (blockIfPolicyOff("analysis")) return [];
  if (input.windows.length === 0) return [];

  const allowedSourceRefs = new Set(
    input.windows.map((window) => window.sourceRef),
  );
  const prompt = buildObservationExtractionPrompt(input.windows);
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride("narrative_observation_extract");
  const response = input.send
    ? await input.send(
        [{ role: "user", content: prompt }],
        {
          projectId,
          pathId: "narrative_observation_extract",
        },
      )
    : await sendChatMessageWithThinking(
        [{ role: "user", content: prompt }],
        {
          projectId,
          pathId: "narrative_observation_extract",
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
    surface: "narrative_observation_extract",
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_OBSERVATION_EXTRACT_PATH },
  });

  const first = await parseObservationsFromText(
    response.text,
    allowedSourceRefs,
    input.createId,
  );
  if (first !== null) return first;
  if (input.repairOnFailure === false) return [];

  const repaired = await runStructuredRepairTask({
    brokenText: response.text,
    expectedShape:
      '{"observations":[{"localId":"string","evidence":[{"sourceRef":"S0001","quote":"string"}],"assertion":{"attribution":"narrator","narrativeFrame":"story-world"},"payload":{"predicate":"string","actuality":"actual","participants":[],"temporalExpressions":[],"durationKind":"instant"}}]}',
    projectId,
  });
  if (!repaired) return [];
  return (
    (await parseObservationsFromText(
      repaired,
      allowedSourceRefs,
      input.createId,
    )) ?? []
  );
}
