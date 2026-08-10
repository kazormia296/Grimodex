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

export async function prepareCodexCommit(
  input: CommitCodexOperationsInput,
): Promise<PrepareCommitResult & { planDigest: string; commitMap: CommitMap }> {
  const operations: CommitOperation[] = input.operations.map((item) => ({
    kind: item.operation.kind,
    payload: item.operation.payload as unknown as Record<string, unknown>,
    proposalId: item.proposalId,
    revisionId: item.revisionId,
  }));
  const commitMap = buildCommitMap(input);
  const planDigest = await computePlanDigest(
    operations,
    null,
    toEntityBindingSeeds(commitMap),
  );
  const prepared = await narrativeExtractionPrepareCommit(
    toCommitWire(input, planDigest),
  );
  return { ...prepared, planDigest, commitMap };
}

export async function applyCodexCommit(
  input: CommitCodexOperationsInput,
  planDigest?: string,
): Promise<ApplyCommitResult> {
  const operations: CommitOperation[] = input.operations.map((item) => ({
    kind: item.operation.kind,
    payload: item.operation.payload as unknown as Record<string, unknown>,
    proposalId: item.proposalId,
    revisionId: item.revisionId,
  }));
  const commitMap = buildCommitMap(input);
  const digest =
    planDigest ??
    (await computePlanDigest(
      operations,
      null,
      toEntityBindingSeeds(commitMap),
    ));
  return narrativeExtractionApplyCommit(toCommitWire(input, digest));
}

export async function prepareAndApplyCodexCommit(
  input: CommitCodexOperationsInput,
): Promise<{
  readonly prepared: PrepareCommitResult;
  readonly applied: ApplyCommitResult;
  readonly status: GetCommitStatusResult;
  readonly commitMap: CommitMap;
}> {
  const prepared = await prepareCodexCommit(input);
  const applied = await applyCodexCommit(input, prepared.planDigest);
  const status = await narrativeExtractionGetCommitStatus({
    projectId: input.projectId,
    requestId: input.requestId,
  });
  return {
    prepared,
    applied,
    status,
    commitMap: prepared.commitMap,
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
