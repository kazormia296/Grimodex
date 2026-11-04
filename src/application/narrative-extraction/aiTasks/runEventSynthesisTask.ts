import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockNarrativeAiTask } from "./narrativeAiTaskGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { digestStableJson } from "@/features/narrative-extraction/source/digest";
import { useTreeStore } from "@/features/tree/treeStore";
import { normalizeEventSynthesis } from "@/features/chronicle/extraction/eventSynthesis";
import { parseRawEventSynthesisResult } from "@/features/chronicle/extraction/schemas";
import type { AiAuditJsonObject } from "@/features/ai-audit/types";
import type {
  EventHypothesis,
  RawEventSynthesisResult,
} from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
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
  CHRONICLE_EVENT_SYNTHESIS_COMPONENT_CONTRACT_ID,
  CHRONICLE_EVENT_SYNTHESIS_COMPONENT_CONTRACT_VERSION,
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

export const NARRATIVE_EVENT_SYNTHESIZE_PATH =
  "narrative_event_synthesize" as const;

const CHRONICLE_PARSED_OUTPUT_DIGEST_DOMAIN = "chronicle.parsed-output/1";

export type EventSynthesisSend = (
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

export interface RunEventSynthesisTaskInput {
  readonly clusterRef: string;
  readonly observations: readonly RawChronicleEventObservation[];
  readonly projectId?: string | null;
  readonly createId?: () => string;
  readonly repairOnFailure?: boolean;
  readonly onParseStatus?: (status: "parsed" | "invalid") => void;
  /** Live eval / tests may inject OpenRouter (or other) transport. */
  readonly send?: EventSynthesisSend;
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
  /**
   * Exact terminal output seam for the Native C1 companion.  It is invoked
   * only after a direct parsed success, a parsed structured-repair child, or
   * the deterministic empty-input terminal; response bodies themselves stay
   * in the audit ledger rather than this callback.
   */
  readonly onTerminalOutput?: (
    output: ChronicleSynthesisTerminalOutput,
  ) => void | Promise<void>;
}

export interface ChronicleSynthesisTerminalOutput {
  readonly rootStageExecution: NarrativeStageExecutionContext;
  readonly terminalStageExecution: NarrativeStageExecutionContext;
  readonly disposition:
    | "root-success"
    | "repair-success"
    | "deterministic-empty";
  readonly clusterRef: string;
  readonly rawObservations: readonly RawChronicleEventObservation[];
  /** Canonical parser projection of the actual terminal response. */
  readonly eventOutput: Readonly<Record<string, unknown>>;
  readonly hypotheses: readonly EventHypothesis[];
  readonly rawObservationsDigest: Sha256Digest;
  readonly parsedOutputDigest: Sha256Digest;
}

const EVENT_COMPONENT_CONTRACT = {
  contractId: CHRONICLE_EVENT_SYNTHESIS_COMPONENT_CONTRACT_ID,
  contractVersion: CHRONICLE_EVENT_SYNTHESIS_COMPONENT_CONTRACT_VERSION,
  instruction: `あなたは小説の出来事統合アシスタントです。同一候補 Cluster 内の Observation を評価し、Event Hypothesis を JSON で返してください。
本文全量は再送しません。Observation Ref と短い Evidence 表示だけを使います。未知の Observation Ref は出力しないでください。
出力の clusterRef は、Context Set の event-cluster の見出し行（contextId=event-cluster:X）の下に書かれた本文の値 X（例：contextId=event-cluster:cluster-0001 なら cluster-0001）を一字一句そのまま使用してください。contextId や inputRef は参照値ではなく、event-cluster: や cluster: を追加せず、出力例のプレースホルダーを値としてコピーしないでください。
出力の events[].observationRefs は、このリクエストの Context Set にある同一候補 Cluster の Observation 行の localId 値だけを一字一句そのままコピーしてください。
contextId や inputRef、出力例のプレースホルダーは参照値ではありません。event-observation: や observation: を追加せず、localId の接頭辞・区切り・桁数を省略、推測、正規化しないでください。別リクエストや別 Cluster の ID は使用しないでください。
events[].significance に使えるのは "major"、"scene-level"、"minor"、"incidental" の 4 種類だけです。
events[].actuality に使えるのは "actual"、"attempted"、"prevented"、"rumored" の 4 種類だけです。年表の出来事にできるのは、この 4 種類のいずれかの actuality を持つ Observation だけです。伝聞・噂の "rumored" も 4 種類に含まれます。
それ以外の actuality（"planned"、"intended"、"hypothetical"、"counterfactual"、"dreamed"、"unknown" など）の Observation は、4 種類のどれかへ書き換えず、どの event の observationRefs にも入れずに省いてください。
1 つの event の observationRefs には同じ actuality の Observation だけを入れ、event の actuality はそれらの Observation の actuality と同じ値にしてください。4 種類の Observation とそれ以外の Observation が同じ Cluster にある場合は、4 種類の Observation だけで event を作り、それ以外は参照しないでください。
Cluster の Observation がすべて 4 種類以外なら、event を作らず、resolution を "unresolved"、events を [] にして返してください。`,
  outputShape: `{"clusterRef":"<cluster-ref-from-context>","resolution":"single-event","events":[{"observationRefs":["<observation-localId-from-context>"],"titleSuggestion":"短いタイトル","summary":"要約","actuality":"actual","significance":"major"}]}
4 種類の actuality の Observation が Cluster に無い場合: {"clusterRef":"<cluster-ref-from-context>","resolution":"unresolved","events":[]}`,
} as const;

/**
 * Structured-repair expected shape. It is a dynamic Context Set value of the
 * repair child, so it does not change the synthesis component contract digest.
 * The cluster's own observation localIds are already model-visible in the
 * synthesis request and in the broken response; they are repeated here only so
 * the repair keeps them verbatim instead of shortening them to an example form.
 */
function eventSynthesisRepairExpectedShape(
  clusterRef: string,
  observations: readonly RawChronicleEventObservation[],
): string {
  const cluster = JSON.stringify(clusterRef);
  const localIds = observations.map((observation) => observation.localId);
  const localIdList = JSON.stringify(localIds);
  const exampleRefs = JSON.stringify(localIds.slice(0, 1));
  return `{"clusterRef":${cluster},"resolution":"single-event","events":[{"observationRefs":${exampleRefs},"titleSuggestion":"t","summary":"s","actuality":"actual","significance":"major"}]}
clusterRef は ${cluster} をそのまま使い、event-cluster: などの接頭辞を付けないでください。
使える localId はこの cluster の ${localIdList} だけです。events[].observationRefs は、壊れた出力の値がそのどれかと一致するなら一字一句そのまま保ち（短縮・正規化をしない）、一致しない値（event-observation: などの余分な接頭辞付き）は、同じ Observation を指す localId に直してください。例の値は形の見本で、event ごとの値は壊れた出力から取ります。
events[].significance は "major"、"scene-level"、"minor"、"incidental" のいずれかです。それ以外の値（"moderate" など）は event を除かず、判断が付かなければ "minor" に直してください。
events[].actuality は "actual"、"attempted"、"prevented"、"rumored" のいずれかです。それ以外の actuality の event は、4 種類のどれかへ書き換えず events から除いてください。
events が空になる場合: {"clusterRef":${cluster},"resolution":"unresolved","events":[]}`;
}

export function buildSynthesisPromptArtifact(
  input: RunEventSynthesisTaskInput,
): ChroniclePromptArtifact {
  const observationRows = input.observations.map((observation) => {
    const quotes = observation.evidence
      .map((item) => `${item.sourceRef}:${item.quote}`)
      .join(" | ");
    return `- localId=${observation.localId}; actuality=${observation.payload.actuality}; predicate=${observation.payload.predicate}; evidence=${quotes}`;
  });
  return buildChroniclePromptArtifact({
    stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
    componentContract: EVENT_COMPONENT_CONTRACT,
    contextSet: [
      {
        contextId: `event-cluster:${input.clusterRef}`,
        inputRef: `cluster:${input.clusterRef}`,
        stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
        exposure: "model-visible" as const,
        selector: { kind: "whole-source" as const },
      },
      ...input.observations.map((observation) => ({
        contextId: `event-observation:${observation.localId}`,
        inputRef: `observation:${observation.localId}`,
        stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
        exposure: "model-visible" as const,
        selector: { kind: "whole-source" as const },
      })),
    ],
    modelInputs: [
      {
        contextId: `event-cluster:${input.clusterRef}`,
        value: input.clusterRef,
      },
      ...input.observations.map((observation, index) => ({
        contextId: `event-observation:${observation.localId}`,
        value: observationRows[index] ?? "",
      })),
    ],
  });
}

async function recordEventStageAudit(
  input: RunEventSynthesisTaskInput,
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
  onStageReceipt?: RunEventSynthesisTaskInput["onStageReceipt"],
  capturedTerminalMetadata?: ChronicleStageAuditMetadata,
  capturedStageReceipt?: ChronicleStageTerminalReceiptV1,
): Promise<void> {
  if (!input.stageExecution) return;
  const digests = await buildChroniclePromptDigests(promptArtifact);
  const digestBinding = await chronicleStageDigestBinding(
    input,
    responseText,
    parseStatus,
  );
  const terminal =
    capturedTerminalMetadata ??
    (await buildChronicleStageAuditTerminal({
      stageExecution: input.stageExecution,
      ...digests,
      responseText,
      parseStatus,
      terminalStatus,
      rawObservationsDigest: digestBinding.rawObservationsDigest,
      parsedOutputDigest: digestBinding.parsedOutputDigest,
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
    surface: "narrative_event_synthesize",
    model: usage.model,
    provider: usage.provider,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    projectId: input.stageExecution.projectId,
    metadata: {
      pathId: NARRATIVE_EVENT_SYNTHESIZE_PATH,
      chronicleStageAudit: terminal,
    },
  });
}

/**
 * The single acceptance predicate for a synthesis response: the schema parses,
 * the clusterRef is the input's, and every event's observationRefs resolve to
 * this cluster's localIds. Native rejects a terminal output whose refs are not
 * all known, so a response that normalization would silently thin out must be
 * invalid here (and eligible for repair), never an apparent success. The
 * predicate is all-or-nothing: one unknown ref in any event (a mix of known
 * and unknown refs, or only a later event) makes the whole response invalid;
 * the known events are not kept as a partial success.
 */
function acceptedSynthesisValue(
  parsed: unknown,
  input: RunEventSynthesisTaskInput,
): RawEventSynthesisResult | null {
  const result = parseRawEventSynthesisResult(parsed);
  if (!result.ok || result.value.clusterRef !== input.clusterRef) return null;
  const known = new Set(
    input.observations.map((observation) => observation.localId),
  );
  return result.value.events.every((event) =>
    event.observationRefs.every((ref) => known.has(ref)),
  )
    ? result.value
    : null;
}

async function parseSynthesisFromText(
  responseText: string,
  input: RunEventSynthesisTaskInput,
): Promise<{
  readonly hypotheses: readonly EventHypothesis[];
  readonly status: "parsed" | "invalid";
  readonly eventOutput: Readonly<Record<string, unknown>> | null;
} | null> {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const accepted = acceptedSynthesisValue(parsed, input);
  const allowedObservationRefs = new Set(
    input.observations.map((observation) => observation.localId),
  );
  return {
    hypotheses: normalizeEventSynthesis(parsed, {
      clusterRef: input.clusterRef,
      allowedObservationRefs,
      createId: input.createId,
    }),
    status: accepted ? "parsed" : "invalid",
    eventOutput: accepted
      ? {
          clusterRef: accepted.clusterRef,
          resolution: accepted.resolution,
          events: accepted.events,
        }
      : null,
  };
}

function synthesisParseStatus(
  responseText: string,
  input: RunEventSynthesisTaskInput,
): "parsed" | "invalid" {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return "invalid";
  try {
    return acceptedSynthesisValue(JSON.parse(jsonText), input)
      ? "parsed"
      : "invalid";
  } catch {
    return "invalid";
  }
}

async function chronicleStageDigestBinding(
  input: RunEventSynthesisTaskInput,
  responseText: string,
  parseStatus: "parsed" | "invalid",
): Promise<{
  readonly rawObservationsDigest: Sha256Digest;
  readonly parsedOutputDigest: Sha256Digest | null;
}> {
  const rawObservationsDigest = await digestStableJson({
    kind: "chronicle.raw-observations@1",
    version: 1,
    observations: input.observations,
  });
  let parsedOutputDigest: Sha256Digest | null = null;
  if (parseStatus === "parsed") {
    const jsonText = extractJsonObject(responseText);
    if (jsonText) {
      try {
        const accepted = acceptedSynthesisValue(JSON.parse(jsonText), input);
        if (accepted) {
          parsedOutputDigest = await digestParsedSynthesisOutput({
            input,
            rawObservationsDigest,
            eventOutput: {
              clusterRef: accepted.clusterRef,
              resolution: accepted.resolution,
              events: accepted.events,
            },
            eventCount: accepted.events.length,
          });
        }
      } catch {
        parsedOutputDigest = null;
      }
    }
  }
  return { rawObservationsDigest, parsedOutputDigest };
}

async function digestParsedSynthesisOutput(input: {
  readonly input: RunEventSynthesisTaskInput;
  readonly rawObservationsDigest: Sha256Digest;
  readonly eventOutput: Readonly<Record<string, unknown>>;
  readonly eventCount: number;
}): Promise<Sha256Digest> {
  const eventOutputDigest = await digestStableJson(input.eventOutput);
  return digestStableJson({
    domain: CHRONICLE_PARSED_OUTPUT_DIGEST_DOMAIN,
    kind: "chronicle.event-synthesis-output@1",
    observationCount: input.input.observations.length,
    eventCount: input.eventCount,
    // The typed C1 output binds the complete raw observation set; Native
    // checks the exact local-id order and recomputes this digest.
    observationRefs: input.input.observations.map(
      (observation) => observation.localId,
    ),
    rawObservationsDigest: input.rawObservationsDigest,
    eventOutputDigest,
  });
}

async function deterministicEmptyOutput(
  input: RunEventSynthesisTaskInput,
): Promise<{
  readonly eventOutput: Readonly<Record<string, unknown>>;
  readonly rawObservationsDigest: Sha256Digest;
  readonly parsedOutputDigest: Sha256Digest;
}> {
  const rawObservationsDigest = await digestStableJson({
    kind: "chronicle.raw-observations@1",
    version: 1,
    observations: input.observations,
  });
  const eventOutput = {
    clusterRef: input.clusterRef,
    resolution: "no-events",
    events: [],
  } as const;
  const parsedOutputDigest = await digestParsedSynthesisOutput({
    input,
    rawObservationsDigest,
    eventOutput,
    eventCount: 0,
  });
  return { eventOutput, rawObservationsDigest, parsedOutputDigest };
}

/**
 * Stage AI: narrative_event_synthesize.
 * Receives observation refs + short evidence display only (no DB ids).
 */
export async function runEventSynthesisTask(
  input: RunEventSynthesisTaskInput,
): Promise<readonly EventHypothesis[]> {
  if (input.stageExecution) {
    assertStageExecutionContext(input.stageExecution);
    if (
      input.projectId !== undefined &&
      input.projectId !== null &&
      input.projectId !== input.stageExecution.projectId
    ) {
      throw new TypeError(
        "Event synthesis projectId must match stage execution projectId",
      );
    }
    if (input.stageExecution.stageId !== NARRATIVE_STAGE_IDS.eventSynthesis) {
      throw new TypeError(
        `Event synthesis requires stageId '${NARRATIVE_STAGE_IDS.eventSynthesis}'`,
      );
    }
  }

  const blocked = blockNarrativeAiTask();
  const emptyInput = input.observations.length === 0;
  if (blocked || emptyInput) {
    if (input.stageExecution) {
      const promptArtifact = buildSynthesisPromptArtifact(input);
      const promptDigests = await buildChroniclePromptDigests(promptArtifact);
      const deterministicOutput =
        emptyInput && !blocked
          ? await deterministicEmptyOutput(input)
          : undefined;
      await emitChronicleStageAuditSkippedReceipt({
        stageExecution: input.stageExecution,
        ...promptDigests,
        projectId: input.stageExecution.projectId,
        pathId: NARRATIVE_EVENT_SYNTHESIZE_PATH,
        request: { messages: promptArtifact.messages },
        reason: blocked
          ? "narrative-event-preflight-blocked"
          : "narrative-event-preflight-empty",
        rawObservationsDigest: deterministicOutput?.rawObservationsDigest,
        parsedOutputDigest: deterministicOutput?.parsedOutputDigest,
        onReceipt: input.onStageReceipt,
      });
      if (deterministicOutput) {
        await input.onTerminalOutput?.({
          rootStageExecution: input.stageExecution,
          terminalStageExecution: input.stageExecution,
          disposition: "deterministic-empty",
          clusterRef: input.clusterRef,
          rawObservations: input.observations,
          eventOutput: deterministicOutput.eventOutput,
          hypotheses: [],
          rawObservationsDigest: deterministicOutput.rawObservationsDigest,
          parsedOutputDigest: deterministicOutput.parsedOutputDigest,
        });
      }
    }
    return [];
  }

  const promptArtifact = buildSynthesisPromptArtifact(input);
  const prompt = promptArtifact.messages[0].content;
  const promptDigests = await buildChroniclePromptDigests(promptArtifact);
  const projectId = requireAuditProjectId(
    input.projectId ??
      input.stageExecution?.projectId ??
      useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride("narrative_event_synthesize");
  const baseAuditContext = {
    projectId,
    pathId: NARRATIVE_EVENT_SYNTHESIZE_PATH,
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
          const parseStatus = synthesisParseStatus(responseText, input);
          const digestBinding = await chronicleStageDigestBinding(
            input,
            responseText,
            parseStatus,
          );
          const terminal = await buildChronicleStageAuditTerminal({
            stageExecution: input.stageExecution!,
            ...promptDigests,
            responseText,
            responseDigest,
            parseStatus,
            rawObservationsDigest: digestBinding.rawObservationsDigest,
            parsedOutputDigest: digestBinding.parsedOutputDigest,
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
  if (!input.stageExecution) {
    void recordAiUsage({
      surface: "narrative_event_synthesize",
      model: ov.model,
      provider: ov.provider,
      tokensIn: response.inputTokens,
      tokensOut: response.outputTokens,
      projectId,
      metadata: { pathId: NARRATIVE_EVENT_SYNTHESIZE_PATH },
    });
  }
  const first = await parseSynthesisFromText(response.text, input);
  if (first?.status === "parsed") {
    input.onParseStatus?.(first.status);
    if (input.stageExecution) {
      await recordEventStageAudit(
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
      );
      const digestBinding = await chronicleStageDigestBinding(
        input,
        response.text,
        "parsed",
      );
      if (
        digestBinding.parsedOutputDigest !== null &&
        first.eventOutput !== null
      ) {
        await input.onTerminalOutput?.({
          rootStageExecution: input.stageExecution,
          terminalStageExecution: input.stageExecution,
          disposition: "root-success",
          clusterRef: input.clusterRef,
          rawObservations: input.observations,
          eventOutput: first.eventOutput,
          hypotheses: first.hypotheses,
          rawObservationsDigest: digestBinding.rawObservationsDigest,
          parsedOutputDigest: digestBinding.parsedOutputDigest,
        });
      }
    }
    return first.hypotheses;
  }
  if (input.repairOnFailure === false) {
    input.onParseStatus?.("invalid");
    if (input.stageExecution) {
      await recordEventStageAudit(
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
    expectedShape: eventSynthesisRepairExpectedShape(
      input.clusterRef,
      input.observations,
    ),
    projectId,
    ...(repairStageExecution ? { stageExecution: repairStageExecution } : {}),
    ...(repairStageExecution
      ? {
          responseValidator: (candidate: string) =>
            synthesisParseStatus(candidate, input),
          terminalOutputDigests: async (
            candidate: string,
            parseStatus: "parsed" | "invalid",
          ) => chronicleStageDigestBinding(input, candidate, parseStatus),
        }
      : {}),
    send: input.repairSend,
    onStageReceipt: input.onStageReceipt,
  });
  if (!repaired) {
    input.onParseStatus?.("invalid");
    if (input.stageExecution) {
      await recordEventStageAudit(
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
      );
    }
    return [];
  }
  const parsed = await parseSynthesisFromText(repaired, input);
  input.onParseStatus?.(parsed?.status ?? "invalid");
  if (input.stageExecution) {
    await recordEventStageAudit(
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
    );
    const digestBinding = await chronicleStageDigestBinding(
      input,
      repaired,
      parsed?.status ?? "invalid",
    );
    if (
      parsed?.status === "parsed" &&
      parsed.eventOutput !== null &&
      digestBinding.parsedOutputDigest !== null &&
      repairStageExecution !== undefined
    ) {
      await input.onTerminalOutput?.({
        rootStageExecution: input.stageExecution,
        terminalStageExecution: repairStageExecution,
        disposition: "repair-success",
        clusterRef: input.clusterRef,
        rawObservations: input.observations,
        eventOutput: parsed.eventOutput,
        hypotheses: parsed.hypotheses,
        rawObservationsDigest: digestBinding.rawObservationsDigest,
        parsedOutputDigest: digestBinding.parsedOutputDigest,
      });
    }
  }
  return parsed?.status === "parsed" ? parsed.hypotheses : [];
}
