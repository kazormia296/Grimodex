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
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";

export const NARRATIVE_STRUCTURED_REPAIR_PATH =
  "narrative_structured_repair" as const;

export interface RunStructuredRepairTaskInput {
  readonly brokenText: string;
  readonly expectedShape: string;
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
) => StructuredRepairParseStatus;

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

function resolveStructuredRepairParseStatus(
  input: RunStructuredRepairTaskInput,
  responseText: string,
): StructuredRepairParseStatus {
  if (!input.stageExecution) return structuredRepairParseStatus(responseText);

  const responseValidator = input.responseValidator;
  if (typeof responseValidator !== "function") {
    throw new TypeError(
      "Structured repair Chronicle stage requires responseValidator",
    );
  }
  try {
    return responseValidator(responseText) === "parsed" ? "parsed" : "invalid";
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
    },
  });
}

/**
 * Stage AI: narrative_structured_repair.
 * Called at most once after a JSON extract/parse failure on another stage.
 */
export async function runStructuredRepairTask(
  input: RunStructuredRepairTaskInput,
): Promise<string | null> {
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

  const blocked = blockNarrativeAiTask();
  const emptyInput =
    input.stageExecution !== undefined && input.brokenText.trim().length === 0;
  if (blocked || emptyInput) {
    if (input.stageExecution) {
      const promptArtifact = buildStructuredRepairPromptArtifact(input);
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

  const promptArtifact = input.stageExecution
    ? buildStructuredRepairPromptArtifact(input)
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
            const parseStatus = resolveStructuredRepairParseStatus(
              input,
              responseText,
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
  const repaired = extractJsonObject(response.text);
  const parseStatus = resolveStructuredRepairParseStatus(input, response.text);
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
    );
  } else {
    void recordAiUsage({
      surface: "narrative_structured_repair",
      model: ov.model,
      provider: ov.provider,
      tokensIn: response.inputTokens,
      tokensOut: response.outputTokens,
      projectId,
      metadata: { pathId: NARRATIVE_STRUCTURED_REPAIR_PATH },
    });
  }

  return input.stageExecution && parseStatus !== "parsed" ? null : repaired;
}
