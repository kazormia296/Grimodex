import type { CreateChronicleEventOperationV1 } from "@/features/chronicle/extraction/compiler";

import type {
  ApplyCommitPayload,
  ApplyCommitResult,
  CommitApplicationRef,
  CommitOperation,
  GetCommitStatusResult,
  PrepareCommitResult,
  UndoCommitPayload,
} from "./nativeApi";
import {
  narrativeExtractionApplyCommit,
  narrativeExtractionGetCommitStatus,
  narrativeExtractionPrepareCommit,
  narrativeExtractionRedoCommit,
  narrativeExtractionUndoCommit,
} from "./nativeApi";

export interface CommitChronicleOperationsInput {
  readonly projectId: string;
  readonly runId: string;
  readonly proposalSetId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly surface?: string;
  readonly operations: readonly {
    readonly operation: CreateChronicleEventOperationV1;
    readonly proposalId: string;
    readonly revisionId: string;
  }[];
  readonly expectedTailOrdinal?: string | null;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return Object.fromEntries(
      entries.map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export async function computePlanDigest(
  operations: readonly CommitOperation[],
  expectedTailOrdinal: string | null | undefined,
): Promise<string> {
  const plan = canonicalize({
    expectedTailOrdinal: expectedTailOrdinal ?? null,
    operations,
  });
  return sha256Hex(JSON.stringify(plan));
}

function toCommitWire(
  input: CommitChronicleOperationsInput,
  planDigest: string,
): ApplyCommitPayload {
  const operations: CommitOperation[] = input.operations.map((item) => ({
    kind: item.operation.kind,
    payload: item.operation.payload as unknown as Record<string, unknown>,
    proposalId: item.proposalId,
    revisionId: item.revisionId,
  }));
  const applications: CommitApplicationRef[] = input.operations.map((item) => ({
    proposalId: item.proposalId,
    revisionId: item.revisionId,
  }));
  return {
    projectId: input.projectId,
    runId: input.runId,
    proposalSetId: input.proposalSetId,
    requestId: input.requestId,
    planDigest,
    sessionId: input.sessionId,
    surface: input.surface,
    operations,
    applications,
    expectedTailOrdinal: input.expectedTailOrdinal ?? null,
  };
}

export async function prepareChronicleCommit(
  input: CommitChronicleOperationsInput,
): Promise<PrepareCommitResult & { planDigest: string }> {
  const operations: CommitOperation[] = input.operations.map((item) => ({
    kind: item.operation.kind,
    payload: item.operation.payload as unknown as Record<string, unknown>,
    proposalId: item.proposalId,
    revisionId: item.revisionId,
  }));
  const planDigest = await computePlanDigest(
    operations,
    input.expectedTailOrdinal,
  );
  const prepared = await narrativeExtractionPrepareCommit(
    toCommitWire(input, planDigest),
  );
  return { ...prepared, planDigest };
}

export async function applyChronicleCommit(
  input: CommitChronicleOperationsInput,
  planDigest?: string,
): Promise<ApplyCommitResult> {
  const operations: CommitOperation[] = input.operations.map((item) => ({
    kind: item.operation.kind,
    payload: item.operation.payload as unknown as Record<string, unknown>,
    proposalId: item.proposalId,
    revisionId: item.revisionId,
  }));
  const digest =
    planDigest ??
    (await computePlanDigest(operations, input.expectedTailOrdinal));
  return narrativeExtractionApplyCommit(toCommitWire(input, digest));
}

export async function prepareAndApplyChronicleCommit(
  input: CommitChronicleOperationsInput,
): Promise<{
  readonly prepared: PrepareCommitResult;
  readonly applied: ApplyCommitResult;
  readonly status: GetCommitStatusResult;
}> {
  const prepared = await prepareChronicleCommit(input);
  const applied = await applyChronicleCommit(input, prepared.planDigest);
  const status = await narrativeExtractionGetCommitStatus({
    projectId: input.projectId,
    requestId: input.requestId,
  });
  return { prepared, applied, status };
}

export async function undoChronicleCommit(
  payload: UndoCommitPayload,
): Promise<ApplyCommitResult> {
  return narrativeExtractionUndoCommit(payload);
}

export async function redoChronicleCommit(
  payload: UndoCommitPayload,
): Promise<ApplyCommitResult> {
  return narrativeExtractionRedoCommit(payload);
}
