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
import type { EvidenceSpanCatalogBinding } from "@/features/narrative-extraction/evidence/spanCatalog";
import {
  type EvidenceSpanCatalogSelectionResolver,
  createEvidenceSpanCatalogSelectionResolver,
} from "@/features/narrative-extraction/evidence/spanCatalog";
import {
  citationBindingAuditMetadata,
  citationIdObservationParseStatus,
  citationSelectionAuditMetadata,
  CITATION_ID_OBSERVATION_EXPECTED_SHAPE,
  CITATION_ID_OBSERVATION_EVIDENCE_MODE,
  LEGACY_OBSERVATION_EVIDENCE_MODE,
  materializeCitationIdObservations,
  type CitationIdObservationSelection,
  type ObservationEvidenceMode,
  buildCitationIdObservationPromptArtifactFromCaptured,
  validateCitationIdBinding,
} from "./citationIdObservation";
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

export type { ObservationEvidenceMode } from "./citationIdObservation";

export const NARRATIVE_OBSERVATION_EXTRACT_PATH =
  "narrative_observation_extract" as const;

export interface ObservationExtractionWindowInput {
  readonly windowId?: string;
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
  /**
   * The quote protocol remains the compatibility default for direct callers.
   * Production AI runs opt into citation-id-v2 explicitly with a sealed
   * EvidenceSpanCatalogBinding.
   */
  readonly evidenceMode?: ObservationEvidenceMode;
  readonly evidenceSpanCatalogBinding?: EvidenceSpanCatalogBinding;
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
  /** Non-authoritative receipt observation seam for shadow/C1 harnesses. */
  readonly onStageReceipt?: (
    receipt: ChronicleStageTerminalReceiptV1,
  ) => void | Promise<void>;
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

function observationEvidenceMode(
  input: RunObservationExtractionTaskInput,
): ObservationEvidenceMode {
  return input.evidenceMode ?? LEGACY_OBSERVATION_EVIDENCE_MODE;
}

function citationIdBinding(
  input: RunObservationExtractionTaskInput,
): EvidenceSpanCatalogBinding {
  if (
    observationEvidenceMode(input) === CITATION_ID_OBSERVATION_EVIDENCE_MODE &&
    input.evidenceSpanCatalogBinding === undefined
  ) {
    throw new TypeError(
      "Citation-ID observation mode requires an EvidenceSpanCatalogBinding",
    );
  }
  return input.evidenceSpanCatalogBinding as EvidenceSpanCatalogBinding;
}

async function buildObservationPromptArtifactForInput(
  input: RunObservationExtractionTaskInput,
  capturedBinding?: EvidenceSpanCatalogBinding,
): Promise<ChroniclePromptArtifact> {
  if (
    observationEvidenceMode(input) === CITATION_ID_OBSERVATION_EVIDENCE_MODE &&
    input.windows.length > 0
  ) {
    if (!capturedBinding) {
      throw new TypeError(
        "Citation-ID observation prompt requires a captured EvidenceSpanCatalogBinding",
      );
    }
    return buildCitationIdObservationPromptArtifactFromCaptured(
      input.windows,
      capturedBinding,
    );
  }
  return buildObservationPromptArtifact(input.windows);
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
  modelExecutionBinding?: StageModelExecutionBindingV1,
  onStageReceipt?: RunObservationExtractionTaskInput["onStageReceipt"],
  capturedTerminalMetadata?: ChronicleStageAuditMetadata,
  capturedStageReceipt?: ChronicleStageTerminalReceiptV1,
  citationAudit?: AiAuditJsonObject,
  repairResolution?: AiAuditJsonObject,
): Promise<void> {
  if (!input.stageExecution) return;
  const digests = await buildChroniclePromptDigests(promptArtifact);
  const terminal =
    capturedTerminalMetadata ??
    (await buildChronicleStageAuditTerminal({
      stageExecution: input.stageExecution,
      ...digests,
      responseText,
      parseStatus,
      terminalStatus,
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
    surface: "narrative_observation_extract",
    model: usage.model,
    provider: usage.provider,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    projectId: input.stageExecution.projectId,
    metadata: {
      pathId: NARRATIVE_OBSERVATION_EXTRACT_PATH,
      chronicleStageAudit: terminal,
      ...(citationAudit ? { citationEvidence: citationAudit } : {}),
      ...(repairResolution ? { repairResolution } : {}),
    },
  });
}

function buildCitationRepairResolutionAudit(
  childResponseDigest: Sha256Digest,
  childStageExecution: NarrativeStageExecutionContext | undefined,
  childCitationAudit: AiAuditJsonObject,
): AiAuditJsonObject {
  const childStage = childStageExecution
    ? {
        projectId: childStageExecution.projectId,
        runId: childStageExecution.runId,
        taskId: childStageExecution.taskId,
        attemptId: childStageExecution.attemptId,
        stageId: childStageExecution.stageId,
        stageExecutionId: childStageExecution.stageExecutionId,
        ...(childStageExecution.parentStageExecutionId === undefined
          ? {}
          : {
              parentStageExecutionId:
                childStageExecution.parentStageExecutionId,
            }),
      }
    : null;
  return {
    kind: "chronicle.observation-repair-resolution@1",
    version: 1,
    childResponseDigest,
    childStageExecution: childStage,
    childCitationEvidence: childCitationAudit,
  };
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

async function observationParseStatusForInput(
  input: RunObservationExtractionTaskInput,
  responseText: string,
  binding?: EvidenceSpanCatalogBinding,
): Promise<"parsed" | "invalid"> {
  if (
    observationEvidenceMode(input) === CITATION_ID_OBSERVATION_EVIDENCE_MODE
  ) {
    return citationIdObservationParseStatus(
      responseText,
      binding ?? citationIdBinding(input),
    );
  }
  return observationParseStatus(responseText);
}

function captureObservationExtractionInput(
  input: RunObservationExtractionTaskInput,
): RunObservationExtractionTaskInput {
  const windows = input.windows.map((window) => ({
    ...(window.windowId === undefined ? {} : { windowId: window.windowId }),
    sourceRef: window.sourceRef,
    text: window.text,
  }));
  const evidenceMode = observationEvidenceMode(input);
  return {
    ...input,
    windows,
    evidenceMode,
    ...(input.evidenceSpanCatalogBinding
      ? { evidenceSpanCatalogBinding: input.evidenceSpanCatalogBinding }
      : {}),
  };
}

async function citationAuditForResponse(
  input: RunObservationExtractionTaskInput,
  responseText: string,
  binding?: EvidenceSpanCatalogBinding,
  selectionResolver?: EvidenceSpanCatalogSelectionResolver,
  selections?: readonly CitationIdObservationSelection[],
): Promise<AiAuditJsonObject | undefined> {
  if (
    observationEvidenceMode(input) !== CITATION_ID_OBSERVATION_EVIDENCE_MODE
  ) {
    return undefined;
  }
  const resolvedBinding = binding ?? citationIdBinding(input);
  const selectionStatus = await citationIdObservationParseStatus(
    responseText,
    resolvedBinding,
    selectionResolver,
  );
  return {
    ...citationBindingAuditMetadata(resolvedBinding),
    ...(selectionStatus === "parsed" && selections
      ? citationSelectionAuditMetadata(selections)
      : {}),
    selectionStatus: selectionStatus === "parsed" ? "resolved" : "rejected",
  };
}

/**
 * Stage AI: narrative_observation_extract.
 * Passes only Source View refs (S0001…) — never project/scene/event DB ids.
 */
export async function runObservationExtractionTask(
  callerInput: RunObservationExtractionTaskInput,
): Promise<readonly RawChronicleEventObservation[]> {
  // Capture the caller-owned roster, mode, and binding synchronously. Nothing
  // below may reread a mutable input object after an asynchronous boundary.
  const input = captureObservationExtractionInput(callerInput);
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

  const isCitationId =
    observationEvidenceMode(input) === CITATION_ID_OBSERVATION_EVIDENCE_MODE;
  const emptyInput = input.windows.length === 0;
  let capturedCitationBinding: EvidenceSpanCatalogBinding | undefined;
  let citationSelectionResolver:
    | EvidenceSpanCatalogSelectionResolver
    | undefined;
  if (isCitationId && !emptyInput) {
    capturedCitationBinding = await validateCitationIdBinding(
      citationIdBinding(input),
    );
    citationSelectionResolver =
      await createEvidenceSpanCatalogSelectionResolver(capturedCitationBinding);
  }
  const blocked = blockNarrativeAiTask();
  if (blocked || emptyInput) {
    if (input.stageExecution) {
      const promptArtifact = await buildObservationPromptArtifactForInput(
        input,
        capturedCitationBinding,
      );
      const promptDigests = await buildChroniclePromptDigests(promptArtifact);
      await emitChronicleStageAuditSkippedReceipt({
        stageExecution: input.stageExecution,
        ...promptDigests,
        projectId: input.stageExecution.projectId,
        pathId: NARRATIVE_OBSERVATION_EXTRACT_PATH,
        request: { messages: promptArtifact.messages },
        reason: blocked
          ? "narrative-observation-preflight-blocked"
          : "narrative-observation-preflight-empty",
        onReceipt: input.onStageReceipt,
      });
    }
    return [];
  }

  const allowedSourceRefs = new Set(
    input.windows.map((window) => window.sourceRef),
  );
  const promptArtifact = await buildObservationPromptArtifactForInput(
    input,
    capturedCitationBinding,
  );
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
    ...(observationEvidenceMode(input) === CITATION_ID_OBSERVATION_EVIDENCE_MODE
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
  const auditContext = input.stageExecution
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
          const parseStatus = await observationParseStatusForInput(
            input,
            responseText,
            capturedCitationBinding,
          );
          const citationAudit = await citationAuditForResponse(
            input,
            responseText,
            capturedCitationBinding,
            citationSelectionResolver,
          );
          const terminal = await buildChronicleStageAuditTerminal({
            stageExecution: input.stageExecution!,
            ...promptDigests,
            responseText,
            responseDigest,
            parseStatus,
            terminalStatus: parseStatus === "parsed" ? "succeeded" : "failed",
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
            ...(citationAudit ? { citationEvidence: citationAudit } : {}),
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
  let first: {
    readonly observations: readonly RawChronicleEventObservation[];
    readonly status: "parsed" | "invalid";
    readonly selections?: readonly CitationIdObservationSelection[];
  } | null = null;
  let firstCitationError: unknown;
  if (isCitationId) {
    try {
      const materialized = await materializeCitationIdObservations(
        response.text,
        capturedCitationBinding!,
        input.createId,
        citationSelectionResolver,
      );
      first = {
        observations: materialized.observations,
        selections: materialized.selections,
        status: "parsed",
      };
    } catch (error) {
      firstCitationError = error;
    }
  } else {
    first = await parseObservationsFromText(
      response.text,
      allowedSourceRefs,
      input.createId,
    );
  }
  const firstCitationAudit = await citationAuditForResponse(
    input,
    response.text,
    capturedCitationBinding,
    citationSelectionResolver,
    first?.selections,
  );
  if (!input.stageExecution) {
    void recordAiUsage({
      surface: "narrative_observation_extract",
      model: ov.model,
      provider: ov.provider,
      tokensIn: response.inputTokens,
      tokensOut: response.outputTokens,
      projectId,
      metadata: {
        pathId: NARRATIVE_OBSERVATION_EXTRACT_PATH,
        ...(firstCitationAudit ? { citationEvidence: firstCitationAudit } : {}),
      },
    });
  }
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
        sealedModelBinding,
        emitStageReceipt,
        capturedTerminalMetadata,
        capturedStageReceipt,
        firstCitationAudit,
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
        sealedModelBinding,
        emitStageReceipt,
        capturedTerminalMetadata,
        capturedStageReceipt,
        firstCitationAudit,
      );
    }
    if (isCitationId) {
      throw (
        firstCitationError ??
        new Error("NEX_CHRONICLE_CITATION_ID_RESPONSE_INVALID")
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
  let childResponseDigest: Sha256Digest | undefined;
  const observeRepairStageReceipt = async (
    receipt: ChronicleStageTerminalReceiptV1,
  ): Promise<void> => {
    if (
      repairStageExecution &&
      receipt.stageExecution.stageExecutionId ===
        repairStageExecution.stageExecutionId &&
      receipt.responseDigest !== null
    ) {
      // Prefer the digest from the actual child terminal receipt. The child
      // response callback below remains the fallback for a transport that
      // does not expose a stage receipt.
      childResponseDigest = receipt.responseDigest;
    }
    await input.onStageReceipt?.(receipt);
  };

  const repaired = await runStructuredRepairTask({
    brokenText: response.text,
    expectedShape: isCitationId
      ? CITATION_ID_OBSERVATION_EXPECTED_SHAPE
      : '{"observations":[{"localId":"string","evidence":[{"sourceRef":"S0001","quote":"string"}],"assertion":{"attribution":"narrator","narrativeFrame":"story-world"},"payload":{"predicate":"string","actuality":"actual","participants":[],"temporalExpressions":[],"durationKind":"instant"}}]}',
    projectId,
    ...(isCitationId
      ? {
          evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
          evidenceSpanCatalogBinding: capturedCitationBinding!,
        }
      : {}),
    ...(repairStageExecution ? { stageExecution: repairStageExecution } : {}),
    ...(repairStageExecution
      ? {
          responseValidator: isCitationId
            ? (candidate: string) =>
                citationIdObservationParseStatus(
                  candidate,
                  capturedCitationBinding!,
                  citationSelectionResolver,
                )
            : observationParseStatus,
        }
      : {}),
    send: input.repairSend,
    onStageReceipt: observeRepairStageReceipt,
    onResponseDigest: (responseDigest) => {
      childResponseDigest = responseDigest;
    },
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
        sealedModelBinding,
        emitStageReceipt,
        capturedTerminalMetadata,
        capturedStageReceipt,
        firstCitationAudit,
      );
    }
    if (isCitationId) {
      throw new Error(
        "NEX_CHRONICLE_CITATION_ID_REPAIR_FAILED: repaired response was not accepted",
      );
    }
    return [];
  }

  let parsed: {
    readonly observations: readonly RawChronicleEventObservation[];
    readonly status: "parsed" | "invalid";
    readonly selections?: readonly CitationIdObservationSelection[];
  } | null = null;
  let repairedCitationError: unknown;
  if (isCitationId) {
    try {
      const materialized = await materializeCitationIdObservations(
        repaired,
        capturedCitationBinding!,
        input.createId,
        citationSelectionResolver,
      );
      parsed = {
        observations: materialized.observations,
        selections: materialized.selections,
        status: "parsed",
      };
    } catch (error) {
      repairedCitationError = error;
    }
  } else {
    parsed = await parseObservationsFromText(
      repaired,
      allowedSourceRefs,
      input.createId,
    );
  }
  const repairedCitationAudit = await citationAuditForResponse(
    input,
    repaired,
    capturedCitationBinding,
    citationSelectionResolver,
    parsed?.selections,
  );
  if (isCitationId && childResponseDigest === undefined) {
    throw new Error(
      "NEX_CHRONICLE_CITATION_ID_REPAIR_DIGEST_MISSING: child response digest was not captured",
    );
  }
  const repairResolution = isCitationId
    ? buildCitationRepairResolutionAudit(
        childResponseDigest!,
        repairStageExecution,
        repairedCitationAudit ??
          citationBindingAuditMetadata(capturedCitationBinding!),
      )
    : undefined;
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
      sealedModelBinding,
      emitStageReceipt,
      capturedTerminalMetadata,
      capturedStageReceipt,
      firstCitationAudit,
      repairResolution,
    );
  }
  if (isCitationId && !parsed) {
    throw (
      repairedCitationError ??
      new Error(
        "NEX_CHRONICLE_CITATION_ID_REPAIR_FAILED: repaired response was not accepted",
      )
    );
  }
  return parsed?.observations ?? [];
}
