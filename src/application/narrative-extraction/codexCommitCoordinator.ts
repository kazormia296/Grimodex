import type {
  CodexDomainOperationV1,
  CommitMap,
} from "@/features/codex/extraction/compiler";
import {
  emptyCommitMap,
  registerCreatedBinding,
  registerExistingBinding,
} from "@/features/codex/extraction/compiler";

import type {
  ApplyCommitPayload,
  ApplyCommitResult,
  CommitApplicationRef,
  CommitOperation,
  EntityBindingSeed,
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
import { computePlanDigest } from "./commitCoordinator";

export interface CommitCodexOperationsInput {
  readonly projectId: string;
  readonly runId: string;
  readonly proposalSetId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly surface?: string;
  readonly operations: readonly {
    readonly operation: CodexDomainOperationV1;
    readonly proposalId: string;
    readonly revisionId: string;
  }[];
  /** Existing-only bindings (no domain write) used by Relation compile / CommitMap. */
  readonly existingBindings?: readonly EntityBindingSeed[];
}

function toEntityBindingSeeds(commitMap: CommitMap): EntityBindingSeed[] {
  return Object.values(commitMap.entityBindings).map((binding) => ({
    narrativeEntityId: binding.narrativeEntityId,
    codexEntryId: binding.codexEntryId,
    source: binding.source,
  }));
}

function buildCommitMap(input: CommitCodexOperationsInput): CommitMap {
  let commitMap = emptyCommitMap();
  for (const seed of input.existingBindings ?? []) {
    commitMap = registerExistingBinding(
      commitMap,
      seed.narrativeEntityId,
      seed.codexEntryId,
    );
  }
  for (const item of input.operations) {
    if (item.operation.kind === "codex.entry.create") {
      commitMap = registerCreatedBinding(
        commitMap,
        item.operation.payload.narrativeEntityId,
        item.operation.payload.entryId,
      );
    } else if (item.operation.kind === "codex.entry.patch") {
      commitMap = registerExistingBinding(
        commitMap,
        item.operation.payload.narrativeEntityId,
        item.operation.payload.entryId,
      );
    } else if (item.operation.kind === "codex.entity.bind-existing") {
      commitMap = registerExistingBinding(
        commitMap,
        item.operation.payload.narrativeEntityId,
        item.operation.payload.entryId,
      );
    }
  }
  return commitMap;
}

function toCommitWire(
  input: CommitCodexOperationsInput,
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
  const commitMap = buildCommitMap(input);
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
    expectedTailOrdinal: null,
    entityBindings: toEntityBindingSeeds(commitMap).filter(
      (seed) => seed.source === "existing",
    ),
  };
}

function toWireOperations(
  input: CommitCodexOperationsInput,
): CommitOperation[] {
  return input.operations.map((item) => ({
    kind: item.operation.kind,
    payload: item.operation.payload as unknown as Record<string, unknown>,
    proposalId: item.proposalId,
    revisionId: item.revisionId,
  }));
}

async function resolvePlanDigest(
  input: CommitCodexOperationsInput,
): Promise<{ readonly planDigest: string; readonly commitMap: CommitMap }> {
  const commitMap = buildCommitMap(input);
  const planDigest = await computePlanDigest(
    toWireOperations(input),
    null,
    toEntityBindingSeeds(commitMap),
  );
  return { planDigest, commitMap };
}

function receiptFromStatus(
  status: GetCommitStatusResult,
  planDigest: string,
): ApplyCommitResult {
  if (status.receipt) {
    return {
      ...status.receipt,
      status: status.status ?? status.receipt.status,
      idempotentReplay: true,
    };
  }
  return {
    commitId: status.commitId ?? "",
    requestId: status.requestId ?? "",
    planDigest: status.planDigest ?? planDigest,
    status: status.status ?? "applied",
    idempotentReplay: true,
  };
}

export async function prepareCodexCommit(
  input: CommitCodexOperationsInput,
): Promise<PrepareCommitResult & { planDigest: string; commitMap: CommitMap }> {
  const { planDigest, commitMap } = await resolvePlanDigest(input);
  const prepared = await narrativeExtractionPrepareCommit(
    toCommitWire(input, planDigest),
  );
  return { ...prepared, planDigest, commitMap };
}

export async function applyCodexCommit(
  input: CommitCodexOperationsInput,
  planDigest?: string,
): Promise<ApplyCommitResult> {
  const digest = planDigest ?? (await resolvePlanDigest(input)).planDigest;
  return narrativeExtractionApplyCommit(toCommitWire(input, digest));
}

/**
 * Idempotent prepare→apply for Codex commits.
 * Status is checked BEFORE prepare so a lost apply response can replay via
 * Native receipt without hitting NEX_PROPOSAL_ALREADY_APPLIED in prepare.
 */
export async function prepareAndApplyCodexCommit(
  input: CommitCodexOperationsInput,
): Promise<{
  readonly prepared: PrepareCommitResult;
  readonly applied: ApplyCommitResult;
  readonly status: GetCommitStatusResult;
  readonly commitMap: CommitMap;
}> {
  const { planDigest, commitMap } = await resolvePlanDigest(input);

  const existing = await narrativeExtractionGetCommitStatus({
    projectId: input.projectId,
    requestId: input.requestId,
  });

  if (existing.found) {
    if (existing.planDigest != null && existing.planDigest !== planDigest) {
      throw new Error(
        "NEX_COMMIT_IDEMPOTENCY_CONFLICT: request id reused with different planDigest",
      );
    }
    const commitStatus = existing.status ?? "unknown";
    if (
      commitStatus === "applied" ||
      commitStatus === "redone" ||
      commitStatus === "undone"
    ) {
      const applied = receiptFromStatus(existing, planDigest);
      return {
        prepared: {
          ok: true,
          requestId: input.requestId,
          planDigest,
          operationCount: input.operations.length,
        },
        applied,
        status: existing,
        commitMap,
      };
    }
    if (commitStatus === "failed") {
      throw new Error(
        existing.errorMessage ??
          `NEX_COMMIT_FAILED: request '${input.requestId}' previously failed`,
      );
    }
    if (commitStatus === "pending") {
      throw new Error(
        `NEX_COMMIT_PENDING: request '${input.requestId}' is still pending`,
      );
    }
  }

  const prepared = await narrativeExtractionPrepareCommit(
    toCommitWire(input, planDigest),
  );
  const applied = await narrativeExtractionApplyCommit(
    toCommitWire(input, planDigest),
  );
  const status = await narrativeExtractionGetCommitStatus({
    projectId: input.projectId,
    requestId: input.requestId,
  });
  return {
    prepared,
    applied,
    status,
    commitMap,
  };
}

export async function undoCodexCommit(
  payload: UndoCommitPayload,
): Promise<ApplyCommitResult> {
  return narrativeExtractionUndoCommit(payload);
}

export async function redoCodexCommit(
  payload: UndoCommitPayload,
): Promise<ApplyCommitResult> {
  return narrativeExtractionRedoCommit(payload);
}
