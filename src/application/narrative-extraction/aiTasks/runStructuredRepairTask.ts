import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockNarrativeAiTask } from "./narrativeAiTaskGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import type { AiAuditJsonObject } from "@/features/ai-audit/types";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  assertStageExecutionContext,
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
  buildChronicleStageAuditNoResponseTerminal,
  emitChronicleStageAuditSkippedReceipt,
  createChronicleStageReceiptEmitter,
  stageModelBindingFromAuditMetadata,
  type ChronicleStageAuditMetadata,
} from "./chronicleStageAudit";
import type {
  ChronicleStageTerminalReceiptV1,
  StageModelExecutionBindingV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";
import { sha256Digest } from "@/features/narrative-extraction/source/digest";
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";
import type { EvidenceSpanCatalogBinding } from "@/features/narrative-extraction/evidence/spanCatalog";
import {
  buildCitationIdRepairPromptArtifactFromCaptured,
  citationBindingAuditMetadata,
  citationIdObservationParseStatus,
  CITATION_ID_OBSERVATION_EVIDENCE_MODE,
  type ObservationEvidenceMode,
  validateCitationIdBinding,
} from "./citationIdObservation";

export const NARRATIVE_STRUCTURED_REPAIR_PATH =
  "narrative_structured_repair" as const;

export interface RunStructuredRepairTaskInput {
  readonly brokenText: string;
  readonly expectedShape: string;
  readonly evidenceMode?: ObservationEvidenceMode;
  readonly evidenceSpanCatalogBinding?: EvidenceSpanCatalogBinding;
  readonly projectId?: string | null;
  /** Child Stage identity when called from a Chronicle pilot stage. */
  readonly stageExecution?: NarrativeStageExecutionContext;
  /** Caller-owned schema status validator; required for Chronicle stages. */
  readonly responseValidator?: StructuredRepairResponseValidator;
  /** Live eval / tests may inject the child-stage transport. */
  readonly send?: StructuredRepairSend;
  /** Non-authoritative receipt observation seam for shadow/C1 harnesses. */
  readonly onStageReceipt?: (
    receipt: ChronicleStageTerminalReceiptV1,
  ) => void | Promise<void>;
  /** Raw provider response digest, before JSON extraction, for parent linkage. */
  readonly onResponseDigest?: (
    responseDigest: Sha256Digest,
  ) => void | Promise<void>;
  /**
   * Parent-stage owned output projection.  A successful repair is the
   * terminal output for its failed parent, so it must seal the same
   * raw-observation and parsed-output coordinates as a direct success.
   */
  readonly terminalOutputDigests?: (
    responseText: string,
    parseStatus: StructuredRepairParseStatus,
  ) => Promise<{
    readonly rawObservationsDigest: Sha256Digest | null;
    readonly parsedOutputDigest: Sha256Digest | null;
  }>;
}

export type StructuredRepairParseStatus = "parsed" | "invalid";

export type StructuredRepairResponseValidator = (
  responseText: string,
) => StructuredRepairParseStatus | Promise<StructuredRepairParseStatus>;

export type StructuredRepairSend = (
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

export type RunStructuredRepairTaskInputWithTransport =
  RunStructuredRepairTaskInput;

const STRUCTURED_REPAIR_COMPONENT_CONTRACT = {
  contractId: "chronicle.structured-repair.prompt",
  contractVersion: "1",
  instruction: `次のモデル出力を、指定の JSON 形へ修復してください。説明文は付けず JSON だけを返します。
Project ID / Scene ID / Event ID などの DB 識別子は新たに作らず、入力に含まれる Source View ref（S0001 形式）だけを維持してください。`,
  outputShape:
    "Return the repaired JSON object itself at the root, matching the expected shape supplied in the Context Set. Do not wrap it in `repairedJson` or any other wrapper property.",
} as const;

function buildStructuredRepairPromptArtifact(
  input: RunStructuredRepairTaskInput,
): ChroniclePromptArtifact {
  return buildChroniclePromptArtifact({
    stageId: NARRATIVE_STAGE_IDS.structuredRepair,
    componentContract: STRUCTURED_REPAIR_COMPONENT_CONTRACT,
    contextSet: [
      {
        contextId: "structured-repair:expected-shape",
        inputRef: "structured-repair:expected-shape",
        stageId: NARRATIVE_STAGE_IDS.structuredRepair,
        exposure: "model-visible",
        selector: { kind: "whole-source" },
      },
      {
        contextId: "structured-repair:broken-response",
        inputRef: "structured-repair:broken-response",
        stageId: NARRATIVE_STAGE_IDS.structuredRepair,
        exposure: "model-visible",
        selector: { kind: "whole-source" },
      },
    ],
    modelInputs: [
      {
        contextId: "structured-repair:expected-shape",
        value: input.expectedShape,
      },
      {
        contextId: "structured-repair:broken-response",
        value: input.brokenText,
      },
    ],
  });
}

function isCitationIdRepair(input: RunStructuredRepairTaskInput): boolean {
  return input.evidenceMode === CITATION_ID_OBSERVATION_EVIDENCE_MODE;
}

function citationIdRepairBinding(
  input: RunStructuredRepairTaskInput,
): EvidenceSpanCatalogBinding {
  if (isCitationIdRepair(input) && !input.evidenceSpanCatalogBinding) {
    throw new TypeError(
      "Citation-ID structured repair requires an EvidenceSpanCatalogBinding",
    );
  }
  return input.evidenceSpanCatalogBinding as EvidenceSpanCatalogBinding;
}

async function buildStructuredRepairPromptArtifactForInput(
  input: RunStructuredRepairTaskInput,
  capturedBinding?: EvidenceSpanCatalogBinding,
): Promise<ChroniclePromptArtifact> {
  if (isCitationIdRepair(input)) {
    if (!capturedBinding) {
      throw new TypeError(
        "Citation-ID structured repair prompt requires a captured EvidenceSpanCatalogBinding",
      );
    }
    return buildCitationIdRepairPromptArtifactFromCaptured({
      expectedShape: input.expectedShape,
      brokenText: input.brokenText,
      binding: capturedBinding,
    });
  }
  return buildStructuredRepairPromptArtifact(input);
}

function captureStructuredRepairInput(
  input: RunStructuredRepairTaskInput,
): RunStructuredRepairTaskInput {
  return {
    ...input,
    brokenText: input.brokenText,
    expectedShape: input.expectedShape,
    ...(input.evidenceMode !== undefined
      ? { evidenceMode: input.evidenceMode }
      : {}),
    ...(input.evidenceSpanCatalogBinding
      ? { evidenceSpanCatalogBinding: input.evidenceSpanCatalogBinding }
      : {}),
  };
}

function buildLegacyStructuredRepairPrompt(
  input: RunStructuredRepairTaskInput,
): string {
  return `次のモデル出力を、指定の JSON 形へ修復してください。説明文は付けず JSON だけを返します。
Project ID / Scene ID / Event ID などの DB 識別子は新たに作らず、入力に含まれる Source View ref（S0001 形式）だけを維持してください。

# 期待する形
${input.expectedShape}

# 壊れた出力
${input.brokenText}`;
}

function structuredRepairParseStatus(
  responseText: string,
): StructuredRepairParseStatus {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return "invalid";
  try {
    JSON.parse(jsonText);
    return "parsed";
  } catch {
    return "invalid";
  }
}

function assertStructuredRepairStageContract(
  input: RunStructuredRepairTaskInput,
): void {
  if (input.stageExecution && typeof input.responseValidator !== "function") {
    throw new TypeError(
      "Structured repair Chronicle stage requires responseValidator",
    );
  }
}

async function resolveStructuredRepairParseStatus(
  input: RunStructuredRepairTaskInput,
  responseText: string,
  capturedBinding?: EvidenceSpanCatalogBinding,
): Promise<StructuredRepairParseStatus> {
  if (!input.stageExecution) {
    if (isCitationIdRepair(input) && capturedBinding) {
      return (await citationIdObservationParseStatus(
        responseText,
        capturedBinding,
      )) === "parsed"
        ? "parsed"
        : "invalid";
    }
    return structuredRepairParseStatus(responseText);
  }

  const responseValidator = input.responseValidator;
  if (typeof responseValidator !== "function") {
    throw new TypeError(
      "Structured repair Chronicle stage requires responseValidator",
    );
  }
  try {
    return (await responseValidator(responseText)) === "parsed"
      ? "parsed"
      : "invalid";
  } catch {
    return "invalid";
  }
}

async function recordStructuredRepairStageAudit(
  input: RunStructuredRepairTaskInput,
  promptArtifact: ChroniclePromptArtifact,
  responseText: string,
  parseStatus: StructuredRepairParseStatus,
  usage: {
    readonly model: string | null | undefined;
    readonly provider: string | null | undefined;
    readonly tokensIn?: number;
    readonly tokensOut?: number;
  },
  modelExecutionBinding?: StageModelExecutionBindingV1,
  onStageReceipt?: RunStructuredRepairTaskInput["onStageReceipt"],
  capturedTerminalMetadata?: ChronicleStageAuditMetadata,
  capturedStageReceipt?: ChronicleStageTerminalReceiptV1,
  citationAudit?: AiAuditJsonObject,
): Promise<void> {
  if (!input.stageExecution) return;
  const digests = await buildChroniclePromptDigests(promptArtifact);
  const outputDigests = input.terminalOutputDigests
    ? await input.terminalOutputDigests(responseText, parseStatus)
    : undefined;
  const terminal =
    capturedTerminalMetadata ??
    (await buildChronicleStageAuditTerminal({
      stageExecution: input.stageExecution,
      ...digests,
      responseText,
      parseStatus,
      terminalStatus: parseStatus === "parsed" ? "succeeded" : "failed",
      rawObservationsDigest: outputDigests?.rawObservationsDigest ?? null,
      parsedOutputDigest: outputDigests?.parsedOutputDigest ?? null,
      modelExecutionBinding,
      onReceipt: onStageReceipt,
    }));
  if (
    capturedTerminalMetadata !== undefined &&
    capturedStageReceipt !== undefined
  ) {
    await onStageReceipt?.(capturedStageReceipt);
  }
  void recordAiUsage({
    surface: "narrative_structured_repair",
    model: usage.model,
    provider: usage.provider,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    projectId: input.stageExecution.projectId,
    metadata: {
      pathId: NARRATIVE_STRUCTURED_REPAIR_PATH,
      chronicleStageAudit: terminal,
      ...(citationAudit ? { citationEvidence: citationAudit } : {}),
    },
  });
}

/**
 * Stage AI: narrative_structured_repair.
 * Called at most once after a JSON extract/parse failure on another stage.
 */
export async function runStructuredRepairTask(
  callerInput: RunStructuredRepairTaskInput,
): Promise<string | null> {
  // Capture the repair payload and protocol before any asynchronous work. A
  // mutable caller must not be able to change the text, mode, or binding
  // between prompt construction, provider response, audit, and validation.
  const input = captureStructuredRepairInput(callerInput);
  if (input.stageExecution) {
    assertStageExecutionContext(input.stageExecution);
    if (
      input.projectId !== undefined &&
      input.projectId !== null &&
      input.projectId !== input.stageExecution.projectId
    ) {
      throw new TypeError(
        "Structured repair projectId must match stage execution projectId",
      );
    }
    if (input.stageExecution.stageId !== NARRATIVE_STAGE_IDS.structuredRepair) {
      throw new TypeError(
        `Structured repair requires stageId '${NARRATIVE_STAGE_IDS.structuredRepair}'`,
      );
    }
  }

  const isCitationId = isCitationIdRepair(input);
  const capturedCitationBinding = isCitationId
    ? await validateCitationIdBinding(citationIdRepairBinding(input))
    : undefined;
  const blocked = blockNarrativeAiTask();
  const emptyInput =
    input.stageExecution !== undefined && input.brokenText.trim().length === 0;
  if (blocked || emptyInput) {
    if (input.stageExecution) {
      const promptArtifact = await buildStructuredRepairPromptArtifactForInput(
        input,
        capturedCitationBinding,
      );
      const promptDigests = await buildChroniclePromptDigests(promptArtifact);
      await emitChronicleStageAuditSkippedReceipt({
        stageExecution: input.stageExecution,
        ...promptDigests,
        projectId: input.stageExecution.projectId,
        pathId: NARRATIVE_STRUCTURED_REPAIR_PATH,
        request: { messages: promptArtifact.messages },
        reason: blocked
          ? "narrative-structured-repair-preflight-blocked"
          : "narrative-structured-repair-preflight-empty",
        onReceipt: input.onStageReceipt,
      });
    }
    return null;
  }

  if (input.stageExecution) {
    assertStructuredRepairStageContract(input);
  }

  const promptArtifact =
    isCitationId || input.stageExecution
      ? await buildStructuredRepairPromptArtifactForInput(
          input,
          capturedCitationBinding,
        )
      : undefined;
  const prompt = promptArtifact
    ? promptArtifact.messages[0].content
    : buildLegacyStructuredRepairPrompt(input);
  const promptDigests = promptArtifact
    ? await buildChroniclePromptDigests(promptArtifact)
    : undefined;

  const projectId = requireAuditProjectId(
    input.projectId ??
      input.stageExecution?.projectId ??
      useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride("narrative_structured_repair");
  const baseAuditContext = {
    projectId,
    pathId: NARRATIVE_STRUCTURED_REPAIR_PATH,
    ...(isCitationId
      ? {
          metadata: {
            citationEvidence: citationBindingAuditMetadata(
              capturedCitationBinding!,
            ),
          },
        }
      : {}),
  } as const;
  let sealedModelBinding: StageModelExecutionBindingV1 | undefined;
  let capturedTerminalMetadata: ChronicleStageAuditMetadata | undefined;
  let capturedStageReceipt: ChronicleStageTerminalReceiptV1 | undefined;
  const emitStageReceipt = createChronicleStageReceiptEmitter(
    input.onStageReceipt,
  );
  const auditContext =
    input.stageExecution && promptDigests
      ? {
          ...bindChronicleStageAuditContext(
            baseAuditContext,
            input.stageExecution,
            promptDigests,
            (binding) => {
              sealedModelBinding = binding;
            },
          ),
          onTerminalMetadata: async (
            responseText: string,
            metadata?: AiAuditJsonObject,
            responseDigest?: Sha256Digest,
          ) => {
            const parseStatus = await resolveStructuredRepairParseStatus(
              input,
              responseText,
              capturedCitationBinding,
            );
            const outputDigests = input.terminalOutputDigests
              ? await input.terminalOutputDigests(responseText, parseStatus)
              : undefined;
            const terminal = await buildChronicleStageAuditTerminal({
              stageExecution: input.stageExecution!,
              ...promptDigests,
              responseText,
              responseDigest,
              parseStatus,
              terminalStatus: parseStatus === "parsed" ? "succeeded" : "failed",
              rawObservationsDigest:
                outputDigests?.rawObservationsDigest ?? null,
              parsedOutputDigest: outputDigests?.parsedOutputDigest ?? null,
              modelExecutionBinding:
                stageModelBindingFromAuditMetadata(metadata) ??
                sealedModelBinding,
              onReceipt: (receipt) => {
                capturedStageReceipt = receipt;
              },
            });
            capturedTerminalMetadata = terminal;
            return {
              chronicleStage: terminal as unknown as AiAuditJsonObject,
              ...(isCitationId
                ? {
                    citationEvidence: citationBindingAuditMetadata(
                      capturedCitationBinding!,
                    ),
                  }
                : {}),
            };
          },
          onNoResponseTerminalMetadata: async (
            terminalStatus: "failed" | "cancelled" | "skipped",
            metadata?: AiAuditJsonObject,
          ) => {
            const terminal = await buildChronicleStageAuditNoResponseTerminal({
              stageExecution: input.stageExecution!,
              ...promptDigests,
              terminalStatus,
              modelExecutionBinding:
                stageModelBindingFromAuditMetadata(metadata) ??
                sealedModelBinding,
              onReceipt: (receipt) => {
                capturedStageReceipt = receipt;
              },
            });
            capturedTerminalMetadata = terminal;
            return {
              chronicleStage: terminal as unknown as AiAuditJsonObject,
            };
          },
          onAuditCompleted: async () => {
            if (capturedStageReceipt !== undefined) {
              await emitStageReceipt(capturedStageReceipt);
            }
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
          pathId: "narrative_structured_repair",
        },
        undefined,
        undefined,
        ov.apiVariant,
        undefined,
        ov.model,
        ov.provider,
        ov.endpointId,
      );
  if (input.onResponseDigest) {
    await input.onResponseDigest(await sha256Digest(response.text));
  }
  const repaired = extractJsonObject(response.text);
  const parseStatus = await resolveStructuredRepairParseStatus(
    input,
    response.text,
    capturedCitationBinding,
  );
  if (input.stageExecution && promptArtifact) {
    await recordStructuredRepairStageAudit(
      input,
      promptArtifact,
      response.text,
      parseStatus,
      {
        model: ov.model,
        provider: ov.provider,
        tokensIn: response.inputTokens,
        tokensOut: response.outputTokens,
      },
      sealedModelBinding,
      emitStageReceipt,
      capturedTerminalMetadata,
      capturedStageReceipt,
      isCitationId
        ? citationBindingAuditMetadata(capturedCitationBinding!)
        : undefined,
    );
  } else {
    void recordAiUsage({
      surface: "narrative_structured_repair",
      model: ov.model,
      provider: ov.provider,
      tokensIn: response.inputTokens,
      tokensOut: response.outputTokens,
      projectId,
      metadata: {
        pathId: NARRATIVE_STRUCTURED_REPAIR_PATH,
        ...(isCitationId
          ? {
              citationEvidence: citationBindingAuditMetadata(
                capturedCitationBinding!,
              ),
            }
          : {}),
      },
    });
  }

  return (input.stageExecution || isCitationId) && parseStatus !== "parsed"
    ? null
    : repaired;
}
