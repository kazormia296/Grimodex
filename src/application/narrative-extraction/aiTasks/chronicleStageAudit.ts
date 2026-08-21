import {
  assertStageExecutionContext,
  type NarrativeStageExecutionContext,
} from "@/features/narrative-extraction/reconciler/stageExecution";
import { CHRONICLE_CONTEXT_SET_VERSION } from "@/features/narrative-extraction/reconciler/chroniclePromptBuilder";
import { sha256Digest } from "@/features/narrative-extraction/source/digest";
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";
import type { AiAuditJsonObject } from "@/features/ai-audit/types";
import type { AiAuditTransportContext } from "@/features/ai-audit/transportContext";

export const CHRONICLE_STAGE_AUDIT_VERSION = 1 as const;

export type ChronicleParseStatus = "parsed" | "invalid" | "not-attempted";
export type ChronicleTerminalStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface ChronicleStageAuditDigests {
  readonly contextSetDigest: Sha256Digest;
  readonly componentContractDigest: Sha256Digest;
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
  readonly responseDigest?: Sha256Digest;
  readonly parseStatus?: ChronicleParseStatus;
  readonly terminalStatus?: ChronicleTerminalStatus;
  readonly repairParentStageExecutionId?: string;
  readonly repairChildStageExecutionId?: string | null;
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

function operationIdForStage(
  stageExecution: NarrativeStageExecutionContext,
): string {
  return [
    stageExecution.runId,
    stageExecution.taskId,
    stageExecution.attemptId,
  ].join(":");
}

function stageMetadata(
  stageExecution: NarrativeStageExecutionContext,
  digests: ChronicleStageAuditDigests,
  terminal?: Pick<
    ChronicleStageAuditMetadata,
    | "responseDigest"
    | "parseStatus"
    | "terminalStatus"
    | "repairChildStageExecutionId"
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
  return {
    kind: "chronicle-stage",
    version: CHRONICLE_STAGE_AUDIT_VERSION,
    contextSetVersion: CHRONICLE_CONTEXT_SET_VERSION,
    stageExecution,
    contextSetDigest: digests.contextSetDigest,
    componentContractDigest: digests.componentContractDigest,
    finalRequestDigest: digests.finalRequestDigest,
    ...(stageExecution.parentStageExecutionId !== undefined
      ? {
          repairParentStageExecutionId: stageExecution.parentStageExecutionId,
        }
      : {}),
    ...(terminal?.responseDigest === undefined
      ? {}
      : { responseDigest: terminal.responseDigest }),
    ...(terminal?.parseStatus === undefined
      ? {}
      : { parseStatus: terminal.parseStatus }),
    ...(terminal?.terminalStatus === undefined
      ? {}
      : { terminalStatus: terminal.terminalStatus }),
    ...(terminal?.repairChildStageExecutionId === undefined
      ? {}
      : { repairChildStageExecutionId: terminal.repairChildStageExecutionId }),
  };
}

function assertDigest(
  value: unknown,
  label: string,
): asserts value is Sha256Digest {
  if (typeof value !== "string" || !SHA256_DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
}

/**
 * Bind a pure Chronicle Stage identity to the existing AI Audit transport
 * correlation fields. No new route or persistence schema is introduced.
 */
export function bindChronicleStageAuditContext(
  base: ChronicleStageAuditTransportBase,
  stageExecution: NarrativeStageExecutionContext,
  digests: ChronicleStageAuditDigests,
): AiAuditTransportContext {
  assertStageExecutionContext(stageExecution);
  if (base.projectId !== stageExecution.projectId) {
    throw new TypeError(
      "Chronicle Stage audit projectId must match stage execution projectId",
    );
  }
  const metadata = stageMetadata(stageExecution, digests);
  return {
    ...base,
    projectId: stageExecution.projectId,
    operationId: operationIdForStage(stageExecution),
    executionId: stageExecution.stageExecutionId,
    parentExecutionId: stageExecution.parentStageExecutionId ?? null,
    metadata: {
      ...(base.metadata ?? {}),
      chronicleStage: metadata as unknown as AiAuditJsonObject,
    },
  };
}

export interface BuildChronicleStageAuditTerminalInput extends ChronicleStageAuditDigests {
  readonly stageExecution: NarrativeStageExecutionContext;
  /** Hashed immediately; the response body is never included in the result. */
  readonly responseText: string;
  readonly parseStatus: ChronicleParseStatus;
  readonly terminalStatus: ChronicleTerminalStatus;
  readonly repairChildStageExecutionId?: string | null;
}

/** Build terminal provenance metadata while retaining only a response digest. */
export async function buildChronicleStageAuditTerminal(
  input: BuildChronicleStageAuditTerminalInput,
): Promise<ChronicleStageAuditMetadata> {
  const responseDigest = await sha256Digest(input.responseText);
  return stageMetadata(input.stageExecution, input, {
    responseDigest,
    parseStatus: input.parseStatus,
    terminalStatus: input.terminalStatus,
    repairChildStageExecutionId: input.repairChildStageExecutionId,
  });
}
