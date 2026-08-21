import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockNarrativeAiTask } from "./narrativeAiTaskGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { normalizeWindowObservations } from "@/features/chronicle/extraction/windowExtractor";
import { parseRawChronicleEventObservationList } from "@/features/chronicle/extraction/schemas";
import type { AiAuditJsonObject } from "@/features/ai-audit/types";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import {
  runStructuredRepairTask,
  type StructuredRepairSend,
} from "./runStructuredRepairTask";
import {
  assertStageExecutionContext,
  createChildStageExecutionContext,
  NARRATIVE_STAGE_IDS,
  type NarrativeStageExecutionContext,
} from "@/features/narrative-extraction/reconciler/stageExecution";
import {
  buildChroniclePromptArtifact,
  buildChroniclePromptDigests,
  type ChroniclePromptArtifact,
} from "@/features/narrative-extraction/reconciler/chroniclePromptBuilder";
import {
  bindChronicleStageAuditContext,
  buildChronicleStageAuditTerminal,
} from "./chronicleStageAudit";

export const NARRATIVE_OBSERVATION_EXTRACT_PATH =
  "narrative_observation_extract" as const;

export interface ObservationExtractionWindowInput {
  readonly sourceRef: string;
  readonly text: string;
}

export type ObservationExtractionSend = (
  messages: Parameters<typeof sendChatMessageWithThinking>[0],
  options: Parameters<typeof sendChatMessageWithThinking>[1] & {
    readonly stageExecution?: NarrativeStageExecutionContext;
  },
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
  readonly onParseStatus?: (status: "parsed" | "invalid") => void;
  /** Live eval / tests may inject OpenRouter (or other) transport. */
  readonly send?: ObservationExtractionSend;
  /** Pure Chronicle stage identity; repair is derived as its child. */
  readonly stageExecution?: NarrativeStageExecutionContext;
  /** Injectable ID source for deterministic child-stage tests. */
  readonly createStageExecutionId?: () => string;
  /** Optional transport injection for the inline structured-repair child. */
  readonly repairSend?: StructuredRepairSend;
}

const OBSERVATION_COMPONENT_CONTRACT = {
  contractId: "chronicle.observation-extraction.prompt",
  contractVersion: "1",
  instruction: `あなたは小説本文の観測アシスタントです。与えられた Source View 断片から、作中で提示されている出来事の Observation を JSON で列挙してください。
Project ID / Scene ID / Event ID / DB version は出力にも入力にも使いません。evidence.sourceRef には与えた sourceRef（例: S0001）だけを使います。`,
  outputShape:
    '{"observations":[{"localId":"obs-1","evidence":[{"sourceRef":"S0001","quote":"原文の完全一致引用"}],"assertion":{"attribution":"narrator","narrativeFrame":"story-world"},"payload":{"predicate":"出来事の述語","actuality":"actual","participants":[],"temporalExpressions":[],"durationKind":"instant"}}]}',
} as const;

function buildObservationPromptArtifact(
  windows: readonly ObservationExtractionWindowInput[],
): ChroniclePromptArtifact {
  return buildChroniclePromptArtifact({
    stageId: NARRATIVE_STAGE_IDS.observationExtraction,
    componentContract: OBSERVATION_COMPONENT_CONTRACT,
    contextSet: windows.map((window) => ({
      contextId: `observation-source:${window.sourceRef}`,
      inputRef: window.sourceRef,
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      exposure: "model-visible" as const,
      selector: { kind: "whole-source" as const },
    })),
    modelInputs: windows.map((window) => ({
      contextId: `observation-source:${window.sourceRef}`,
      value: window.text,
    })),
  });
}

/** Production observation prompt (shared with live eval certification). */
export function buildObservationExtractionPrompt(
  windows: readonly ObservationExtractionWindowInput[],
): string {
  return buildObservationPromptArtifact(windows).messages[0].content;
}

async function recordObservationStageAudit(
  input: RunObservationExtractionTaskInput,
  promptArtifact: ChroniclePromptArtifact,
  responseText: string,
  parseStatus: "parsed" | "invalid",
  terminalStatus: "succeeded" | "failed",
  usage: {
    readonly model: string | null | undefined;
    readonly provider: string | null | undefined;
    readonly tokensIn?: number;
    readonly tokensOut?: number;
  },
  repairChildStageExecutionId?: string | null,
): Promise<void> {
  if (!input.stageExecution) return;
  const digests = await buildChroniclePromptDigests(promptArtifact);
  const terminal = await buildChronicleStageAuditTerminal({
    stageExecution: input.stageExecution,
    ...digests,
    responseText,
    parseStatus,
    terminalStatus,
    repairChildStageExecutionId,
  });
  void recordAiUsage({
    surface: "narrative_observation_extract",
    model: usage.model,
    provider: usage.provider,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    projectId: input.stageExecution.projectId,
    metadata: {
      pathId: NARRATIVE_OBSERVATION_EXTRACT_PATH,
      chronicleStageAudit: terminal,
    },
  });
}

async function parseObservationsFromText(
  responseText: string,
  allowedSourceRefs: ReadonlySet<string>,
  createId?: () => string,
): Promise<{
  readonly observations: readonly RawChronicleEventObservation[];
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
  return {
    observations: normalizeWindowObservations(parsed, {
      allowedSourceRefs,
      createId,
    }),
    status: parseRawChronicleEventObservationList(parsed).ok
      ? "parsed"
      : "invalid",
  };
}

function observationParseStatus(responseText: string): "parsed" | "invalid" {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return "invalid";
  try {
    return parseRawChronicleEventObservationList(JSON.parse(jsonText)).ok
      ? "parsed"
      : "invalid";
  } catch {
    return "invalid";
  }
}

/**
 * Stage AI: narrative_observation_extract.
 * Passes only Source View refs (S0001…) — never project/scene/event DB ids.
 */
export async function runObservationExtractionTask(
  input: RunObservationExtractionTaskInput,
): Promise<readonly RawChronicleEventObservation[]> {
  if (blockNarrativeAiTask()) return [];
  if (input.windows.length === 0) return [];

  if (input.stageExecution) {
    assertStageExecutionContext(input.stageExecution);
    if (
      input.projectId !== undefined &&
      input.projectId !== null &&
      input.projectId !== input.stageExecution.projectId
    ) {
      throw new TypeError(
        "Observation extraction projectId must match stage execution projectId",
      );
    }
    if (
      input.stageExecution.stageId !== NARRATIVE_STAGE_IDS.observationExtraction
    ) {
      throw new TypeError(
        `Observation extraction requires stageId '${NARRATIVE_STAGE_IDS.observationExtraction}'`,
      );
    }
  }

  const allowedSourceRefs = new Set(
    input.windows.map((window) => window.sourceRef),
  );
  const promptArtifact = buildObservationPromptArtifact(input.windows);
  const prompt = promptArtifact.messages[0].content;
  const promptDigests = await buildChroniclePromptDigests(promptArtifact);
  const projectId = requireAuditProjectId(
    input.projectId ??
      input.stageExecution?.projectId ??
      useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride("narrative_observation_extract");
  const baseAuditContext = {
    projectId,
    pathId: NARRATIVE_OBSERVATION_EXTRACT_PATH,
  } as const;
  const auditContext = input.stageExecution
    ? {
        ...bindChronicleStageAuditContext(
          baseAuditContext,
          input.stageExecution,
          promptDigests,
        ),
        onTerminalMetadata: async (responseText: string) => {
          const parseStatus = observationParseStatus(responseText);
          const terminal = await buildChronicleStageAuditTerminal({
            stageExecution: input.stageExecution!,
            ...promptDigests,
            responseText,
            parseStatus,
            terminalStatus: parseStatus === "parsed" ? "succeeded" : "failed",
          });
          return {
            chronicleStage: terminal as unknown as AiAuditJsonObject,
          };
        },
      }
    : baseAuditContext;
  const response = input.send
    ? await input.send([{ role: "user", content: prompt }], {
        ...auditContext,
        ...(input.stageExecution
          ? { stageExecution: input.stageExecution }
          : {}),
      })
    : await sendChatMessageWithThinking(
        [{ role: "user", content: prompt }],
        {
          ...auditContext,
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
  if (!input.stageExecution) {
    void recordAiUsage({
      surface: "narrative_observation_extract",
      model: ov.model,
      provider: ov.provider,
      tokensIn: response.inputTokens,
      tokensOut: response.outputTokens,
      projectId,
      metadata: { pathId: NARRATIVE_OBSERVATION_EXTRACT_PATH },
    });
  }
  const first = await parseObservationsFromText(
    response.text,
    allowedSourceRefs,
    input.createId,
  );
  if (first !== null) {
    input.onParseStatus?.(first.status);
    if (input.stageExecution) {
      await recordObservationStageAudit(
        input,
        promptArtifact,
        response.text,
        first.status,
        first.status === "parsed" ? "succeeded" : "failed",
        {
          model: ov.model,
          provider: ov.provider,
          tokensIn: response.inputTokens,
          tokensOut: response.outputTokens,
        },
      );
    }
    return first.observations;
  }
  if (input.repairOnFailure === false) {
    input.onParseStatus?.("invalid");
    if (input.stageExecution) {
      await recordObservationStageAudit(
        input,
        promptArtifact,
        response.text,
        "invalid",
        "failed",
        {
          model: ov.model,
          provider: ov.provider,
          tokensIn: response.inputTokens,
          tokensOut: response.outputTokens,
        },
      );
    }
    return [];
  }

  const repairStageExecution = input.stageExecution
    ? createChildStageExecutionContext(
        input.stageExecution,
        NARRATIVE_STAGE_IDS.structuredRepair,
        (input.createStageExecutionId ?? (() => crypto.randomUUID()))(),
      )
    : undefined;

  const repaired = await runStructuredRepairTask({
    brokenText: response.text,
    expectedShape:
      '{"observations":[{"localId":"string","evidence":[{"sourceRef":"S0001","quote":"string"}],"assertion":{"attribution":"narrator","narrativeFrame":"story-world"},"payload":{"predicate":"string","actuality":"actual","participants":[],"temporalExpressions":[],"durationKind":"instant"}}]}',
    projectId,
    ...(repairStageExecution ? { stageExecution: repairStageExecution } : {}),
    send: input.repairSend,
  });
  if (!repaired) {
    input.onParseStatus?.("invalid");
    if (input.stageExecution) {
      await recordObservationStageAudit(
        input,
        promptArtifact,
        response.text,
        "invalid",
        "failed",
        {
          model: ov.model,
          provider: ov.provider,
          tokensIn: response.inputTokens,
          tokensOut: response.outputTokens,
        },
        repairStageExecution?.stageExecutionId,
      );
    }
    return [];
  }
  const parsed = await parseObservationsFromText(
    repaired,
    allowedSourceRefs,
    input.createId,
  );
  input.onParseStatus?.(parsed?.status ?? "invalid");
  if (input.stageExecution) {
    await recordObservationStageAudit(
      input,
      promptArtifact,
      response.text,
      "invalid",
      "failed",
      {
        model: ov.model,
        provider: ov.provider,
        tokensIn: response.inputTokens,
        tokensOut: response.outputTokens,
      },
      repairStageExecution?.stageExecutionId,
    );
  }
  return parsed?.observations ?? [];
}
