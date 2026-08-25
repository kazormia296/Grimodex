import {
  beginAiAuditExecution,
  skipAiAuditExecution,
} from "@/features/ai-audit/api";
import type {
  AiAuditJsonObject,
  AiAuditRequestSnapshot,
} from "@/features/ai-audit/types";
import {
  assertStageExecutionContext,
  type NarrativeStageExecutionContext,
} from "@/features/narrative-extraction/reconciler/stageExecution";
import { CHRONICLE_CONTEXT_SET_VERSION } from "@/features/narrative-extraction/reconciler/chroniclePromptBuilder";
import {
  assertChronicleStageTerminalReceiptV1,
  createStageModelExecutionBindingFromRoute,
  createStageModelExecutionBindingV1,
  digestStageModelExecutionBinding,
  buildChronicleStageTerminalReceiptV1,
  type ChronicleStageParseStatus,
  type ChronicleStageTerminalStatus,
  type ChronicleStageTerminalReceiptV1,
  type StageModelExecutionBindingV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";
import { sha256Digest } from "@/features/narrative-extraction/source/digest";
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";
import type {
  AiAuditResolvedRouteSnapshot,
  AiAuditTransportContext,
} from "@/features/ai-audit/transportContext";

export const CHRONICLE_STAGE_AUDIT_VERSION = 2 as const;

export type ChronicleParseStatus = ChronicleStageParseStatus;
export type ChronicleTerminalStatus = ChronicleStageTerminalStatus;

export interface ChronicleStageAuditDigests {
  readonly contextSetDigest: Sha256Digest;
  readonly componentContractDigest: Sha256Digest;
  /** Deliberately request-only; model identity is a sidecar field. */
  readonly finalRequestDigest: Sha256Digest;
}

export interface ChronicleStageAuditMetadata {
  readonly kind: "chronicle-stage";
  readonly version: typeof CHRONICLE_STAGE_AUDIT_VERSION;
  readonly contextSetVersion: typeof CHRONICLE_CONTEXT_SET_VERSION;
  readonly stageExecution: NarrativeStageExecutionContext;
  readonly contextSetDigest: Sha256Digest;
  readonly componentContractDigest: Sha256Digest;
  readonly finalRequestDigest: Sha256Digest;
  readonly modelExecutionBinding: StageModelExecutionBindingV1;
  readonly modelBindingDigest: Sha256Digest;
  readonly responseDigest?: Sha256Digest | null;
  readonly rawObservationsDigest?: Sha256Digest | null;
  readonly parsedOutputDigest?: Sha256Digest | null;
  readonly parseStatus?: ChronicleParseStatus;
  readonly terminalStatus?: ChronicleTerminalStatus;
  /** Present only for terminal v2 metadata. */
  readonly stageExecutionReceiptDigest?: Sha256Digest;
}

export type ChronicleStageAuditTransportBase = Pick<
  AiAuditTransportContext,
  "projectId" | "pathId"
> &
  Partial<
    Pick<
      AiAuditTransportContext,
      "expectedWorkspacePath" | "chatMessageId" | "metadata"
    >
  >;

const UNRESOLVED_MODEL_BINDING = createStageModelExecutionBindingV1({
  resolutionStatus: "unresolved",
  generationMode: "provider-default",
});

/** Stable digest for the fixed unresolved binding used by injected transports. */
const UNRESOLVED_MODEL_BINDING_DIGEST =
  "sha256:1a5d21f727f13c3243548c408f624ad6dcef0d3f5563e90d7be04d8d8d4c71a7" as const;

function operationIdForStage(
  stageExecution: NarrativeStageExecutionContext,
): string {
  return [
    stageExecution.runId,
    stageExecution.taskId,
    stageExecution.attemptId,
  ].join(":");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isChronicleStageMetadata(
  value: unknown,
): value is ChronicleStageAuditMetadata {
  return (
    isRecord(value) &&
    value.kind === "chronicle-stage" &&
    value.version === CHRONICLE_STAGE_AUDIT_VERSION &&
    isRecord(value.modelExecutionBinding) &&
    typeof value.modelBindingDigest === "string"
  );
}

function stageMetadata(
  stageExecution: NarrativeStageExecutionContext,
  digests: ChronicleStageAuditDigests,
  modelExecutionBinding: StageModelExecutionBindingV1 = UNRESOLVED_MODEL_BINDING,
  modelBindingDigest: Sha256Digest = UNRESOLVED_MODEL_BINDING_DIGEST,
  terminal?: Pick<
    ChronicleStageAuditMetadata,
    | "responseDigest"
    | "rawObservationsDigest"
    | "parsedOutputDigest"
    | "parseStatus"
    | "terminalStatus"
    | "stageExecutionReceiptDigest"
  >,
): ChronicleStageAuditMetadata {
  assertStageExecutionContext(stageExecution);
  assertDigest(digests.contextSetDigest, "Chronicle Stage contextSetDigest");
  assertDigest(
    digests.componentContractDigest,
    "Chronicle Stage componentContractDigest",
  );
  assertDigest(
    digests.finalRequestDigest,
    "Chronicle Stage finalRequestDigest",
  );
  assertDigest(modelBindingDigest, "Chronicle Stage modelBindingDigest");
  return {
    kind: "chronicle-stage",
    version: CHRONICLE_STAGE_AUDIT_VERSION,
    contextSetVersion: CHRONICLE_CONTEXT_SET_VERSION,
    stageExecution,
    contextSetDigest: digests.contextSetDigest,
    componentContractDigest: digests.componentContractDigest,
    finalRequestDigest: digests.finalRequestDigest,
    modelExecutionBinding,
    modelBindingDigest,
    ...(terminal?.responseDigest === undefined
      ? {}
      : { responseDigest: terminal.responseDigest }),
    ...(terminal?.rawObservationsDigest === undefined
      ? {}
      : { rawObservationsDigest: terminal.rawObservationsDigest }),
    ...(terminal?.parsedOutputDigest === undefined
      ? {}
      : { parsedOutputDigest: terminal.parsedOutputDigest }),
    ...(terminal?.parseStatus === undefined
      ? {}
      : { parseStatus: terminal.parseStatus }),
    ...(terminal?.terminalStatus === undefined
      ? {}
      : { terminalStatus: terminal.terminalStatus }),
    ...(terminal?.stageExecutionReceiptDigest === undefined
      ? {}
      : { stageExecutionReceiptDigest: terminal.stageExecutionReceiptDigest }),
  };
}

function assertDigest(
  value: unknown,
  label: string,
): asserts value is Sha256Digest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
}

function chronicleMetadataFrom(
  metadata: AiAuditJsonObject | undefined,
): ChronicleStageAuditMetadata | undefined {
  const stage = metadata?.chronicleStage;
  return isChronicleStageMetadata(stage) ? stage : undefined;
}

function mergeMetadata(
  base: AiAuditJsonObject | undefined,
  stage: ChronicleStageAuditMetadata,
): AiAuditJsonObject {
  const existing = chronicleMetadataFrom(base);
  return {
    ...(base ?? {}),
    chronicleStage: {
      ...(existing ?? {}),
      ...stage,
    } as unknown as AiAuditJsonObject,
  };
}

/**
 * Bind a pure Stage identity to the existing audit transport correlation
 * fields. The returned route callback seals one model binding before audit
 * begin; transports that omit the callback remain unresolved.
 */
export function bindChronicleStageAuditContext(
  base: ChronicleStageAuditTransportBase,
  stageExecution: NarrativeStageExecutionContext,
  digests: ChronicleStageAuditDigests,
  onBindingResolved?: (binding: StageModelExecutionBindingV1) => void,
): AiAuditTransportContext {
  assertStageExecutionContext(stageExecution);
  if (base.projectId !== stageExecution.projectId) {
    throw new TypeError(
      "Chronicle Stage audit projectId must match stage execution projectId",
    );
  }
  let sealedBinding = UNRESOLVED_MODEL_BINDING;
  let sealedBindingDigest: Sha256Digest = UNRESOLVED_MODEL_BINDING_DIGEST;
  const initialMetadata = stageMetadata(
    stageExecution,
    digests,
    sealedBinding,
    sealedBindingDigest,
  );
  const onResolvedRouteMetadata = async (
    route: AiAuditResolvedRouteSnapshot,
    args: Readonly<Record<string, unknown>>,
  ): Promise<AiAuditJsonObject> => {
    const candidate = createStageModelExecutionBindingFromRoute(route, args);
    const candidateDigest = await digestStageModelExecutionBinding(candidate);
    if (
      sealedBindingDigest !== UNRESOLVED_MODEL_BINDING_DIGEST &&
      sealedBindingDigest !== candidateDigest
    ) {
      throw new TypeError("Chronicle Stage model binding was resolved twice");
    }
    sealedBinding = candidate;
    sealedBindingDigest = candidateDigest;
    onBindingResolved?.(sealedBinding);
    return {
      chronicleStage: stageMetadata(
        stageExecution,
        digests,
        sealedBinding,
        sealedBindingDigest,
      ) as unknown as AiAuditJsonObject,
    };
  };
  const context: AiAuditTransportContext = {
    ...base,
    projectId: stageExecution.projectId,
    operationId: operationIdForStage(stageExecution),
    executionId: stageExecution.stageExecutionId,
    parentExecutionId: stageExecution.parentStageExecutionId ?? null,
    metadata: mergeMetadata(base.metadata, initialMetadata),
    onResolvedRouteMetadata,
  };
  return context;
}

export interface BuildChronicleStageAuditTerminalInput extends ChronicleStageAuditDigests {
  readonly stageExecution: NarrativeStageExecutionContext;
  /** Response body is never included in the result. */
  readonly responseText: string;
  /** Trusted transport digest; avoids rehashing when Web Crypto is unavailable. */
  readonly responseDigest?: Sha256Digest;
  readonly rawObservationsDigest?: Sha256Digest | null;
  readonly parsedOutputDigest?: Sha256Digest | null;
  readonly parseStatus: ChronicleParseStatus;
  readonly terminalStatus: ChronicleTerminalStatus;
  /** Exact binding sealed by the route callback, or unresolved when omitted. */
  readonly modelExecutionBinding?: StageModelExecutionBindingV1;
  /** Optional non-authoritative observation seam for shadow/C1 harnesses. */
  readonly onReceipt?: (
    receipt: ChronicleStageTerminalReceiptV1,
  ) => void | Promise<void>;
}

export interface BuildChronicleStageAuditNoResponseInput extends ChronicleStageAuditDigests {
  readonly stageExecution: NarrativeStageExecutionContext;
  /** Terminal path closed without receiving a provider response. */
  readonly terminalStatus: "failed" | "cancelled" | "skipped";
  /** Exact binding sealed by the route callback, or unresolved when omitted. */
  readonly modelExecutionBinding?: StageModelExecutionBindingV1;
  /** Optional non-authoritative observation seam for shadow/C1 harnesses. */
  readonly onReceipt?: (
    receipt: ChronicleStageTerminalReceiptV1,
  ) => void | Promise<void>;
}

/** Build v2 terminal metadata and the sealed v1 terminal receipt atomically. */
export async function buildChronicleStageAuditTerminal(
  input: BuildChronicleStageAuditTerminalInput,
): Promise<ChronicleStageAuditMetadata> {
  const responseDigest =
    input.responseDigest ?? (await sha256Digest(input.responseText));
  assertDigest(responseDigest, "Chronicle Stage responseDigest");
  const modelExecutionBinding =
    input.modelExecutionBinding ?? UNRESOLVED_MODEL_BINDING;
  const modelBindingDigest = await digestStageModelExecutionBinding(
    modelExecutionBinding,
  );
  const receipt = await buildChronicleStageTerminalReceiptV1({
    stageExecution: input.stageExecution,
    contextSetVersion: CHRONICLE_CONTEXT_SET_VERSION,
    contextSetDigest: input.contextSetDigest,
    componentContractDigest: input.componentContractDigest,
    finalRequestDigest: input.finalRequestDigest,
    modelExecutionBinding,
    modelBindingDigest,
    responseDigest,
    rawObservationsDigest: input.rawObservationsDigest ?? null,
    parsedOutputDigest: input.parsedOutputDigest ?? null,
    parseStatus: input.parseStatus,
    terminalStatus: input.terminalStatus,
  });
  await assertChronicleStageTerminalReceiptV1(receipt);
  await input.onReceipt?.(receipt);
  return stageMetadata(
    input.stageExecution,
    input,
    modelExecutionBinding,
    modelBindingDigest,
    {
      responseDigest,
      rawObservationsDigest: input.rawObservationsDigest ?? null,
      parsedOutputDigest: input.parsedOutputDigest ?? null,
      parseStatus: input.parseStatus,
      terminalStatus: input.terminalStatus,
      stageExecutionReceiptDigest: receipt.stageExecutionReceiptDigest,
    },
  );
}

/** Build a terminal v2 receipt for a durable no-response path. */
export async function buildChronicleStageAuditNoResponseTerminal(
  input: BuildChronicleStageAuditNoResponseInput,
): Promise<ChronicleStageAuditMetadata> {
  const modelExecutionBinding =
    input.modelExecutionBinding ?? UNRESOLVED_MODEL_BINDING;
  const modelBindingDigest = await digestStageModelExecutionBinding(
    modelExecutionBinding,
  );
  const receipt = await buildChronicleStageTerminalReceiptV1({
    stageExecution: input.stageExecution,
    contextSetVersion: CHRONICLE_CONTEXT_SET_VERSION,
    contextSetDigest: input.contextSetDigest,
    componentContractDigest: input.componentContractDigest,
    finalRequestDigest: input.finalRequestDigest,
    modelExecutionBinding,
    modelBindingDigest,
    responseDigest: null,
    parseStatus: "not-attempted",
    terminalStatus: input.terminalStatus,
  });
  await assertChronicleStageTerminalReceiptV1(receipt);
  await input.onReceipt?.(receipt);
  return stageMetadata(
    input.stageExecution,
    input,
    modelExecutionBinding,
    modelBindingDigest,
    {
      responseDigest: null,
      parseStatus: "not-attempted",
      terminalStatus: input.terminalStatus,
      stageExecutionReceiptDigest: receipt.stageExecutionReceiptDigest,
    },
  );
}

/**
 * Close a supplied Stage execution when policy/preflight prevents dispatch.
 * The receipt intentionally carries the unresolved binding and null response
 * digest; it is still a durable, canonical terminal rather than an omitted
 * audit event.
 */
export async function emitChronicleStageAuditSkippedReceipt(
  input: Omit<BuildChronicleStageAuditNoResponseInput, "terminalStatus"> & {
    readonly projectId: string;
    readonly pathId: string;
    readonly request: AiAuditRequestSnapshot;
    readonly reason: string;
    readonly expectedWorkspacePath?: string;
  },
): Promise<void> {
  let capturedReceipt: ChronicleStageTerminalReceiptV1 | undefined;
  const terminal = await buildChronicleStageAuditNoResponseTerminal({
    stageExecution: input.stageExecution,
    contextSetDigest: input.contextSetDigest,
    componentContractDigest: input.componentContractDigest,
    finalRequestDigest: input.finalRequestDigest,
    terminalStatus: "skipped",
    modelExecutionBinding: input.modelExecutionBinding,
    onReceipt: (receipt) => {
      capturedReceipt = receipt;
    },
  });
  const metadata = {
    chronicleStage: terminal as unknown as AiAuditJsonObject,
  };
  const {
    responseDigest: _responseDigest,
    parseStatus: _parseStatus,
    terminalStatus: _terminalStatus,
    stageExecutionReceiptDigest: _stageExecutionReceiptDigest,
    ...beginStage
  } = terminal;
  const beginMetadata = {
    chronicleStage: beginStage as unknown as AiAuditJsonObject,
  };
  const audit = await beginAiAuditExecution({
    projectId: input.projectId,
    ...(input.expectedWorkspacePath === undefined
      ? {}
      : { expectedWorkspacePath: input.expectedWorkspacePath }),
    pathId: input.pathId,
    operationId: operationIdForStage(input.stageExecution),
    executionId: input.stageExecution.stageExecutionId,
    parentExecutionId: input.stageExecution.parentStageExecutionId ?? null,
    request: input.request,
    metadata: beginMetadata,
    captureState: "complete",
  });
  await skipAiAuditExecution(audit, {
    reason: input.reason,
    metadata,
  });
  if (capturedReceipt !== undefined) {
    await input.onReceipt?.(capturedReceipt);
  }
}

/** Extract the exact binding from durable begin metadata for terminal sealing. */
export function stageModelBindingFromAuditMetadata(
  metadata: AiAuditJsonObject | undefined,
): StageModelExecutionBindingV1 | undefined {
  const stage = chronicleMetadataFrom(metadata);
  if (!stage) return undefined;
  return stage.modelExecutionBinding;
}

/** Ensure a transport terminal hook and the ai_usage mirror emit one receipt. */
export function createChronicleStageReceiptEmitter(
  onReceipt:
    | ((
        receipt: import("@/features/narrative-extraction/reconciler/stageProvenance").ChronicleStageTerminalReceiptV1,
      ) => void | Promise<void>)
    | undefined,
): (
  receipt: import("@/features/narrative-extraction/reconciler/stageProvenance").ChronicleStageTerminalReceiptV1,
) => Promise<void> {
  let emitted = false;
  let emittedReceiptDigest: string | undefined;
  let inFlight: Promise<void> | undefined;
  let inFlightReceiptDigest: string | undefined;
  return async (receipt) => {
    if (emitted) {
      if (
        emittedReceiptDigest !== undefined &&
        emittedReceiptDigest !== receipt.stageExecutionReceiptDigest
      ) {
        throw new TypeError(
          "Chronicle Stage receipt emitter received a conflicting receipt",
        );
      }
      return;
    }
    if (inFlight !== undefined) {
      if (inFlightReceiptDigest !== receipt.stageExecutionReceiptDigest) {
        throw new TypeError(
          "Chronicle Stage receipt emitter received a conflicting receipt",
        );
      }
      await inFlight;
      return;
    }
    inFlightReceiptDigest = receipt.stageExecutionReceiptDigest;
    inFlight = (async () => {
      await onReceipt?.(receipt);
      emitted = true;
      emittedReceiptDigest = receipt.stageExecutionReceiptDigest;
    })();
    try {
      await inFlight;
    } finally {
      if (!emitted) {
        inFlight = undefined;
        inFlightReceiptDigest = undefined;
      }
    }
  };
}

export const chronicleStageAuditUnresolvedBinding = UNRESOLVED_MODEL_BINDING;
