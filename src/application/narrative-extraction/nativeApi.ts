import { invoke } from "@/lib/tauri";

import type {
  NarrativeExtractionRunProjection,
  NarrativeProposalDecision,
  NarrativeProposalStatus,
} from "@/features/narrative-extraction/runtime/types";
import type {
  ReconciliationEnvelopeV1,
  ReconciliationEnvelopeV2,
} from "@/features/narrative-extraction/reconciler/types";
import type { NarrativeScopeAuthorityBasisV2 } from "@/features/narrative-extraction/source/scopeAuthorityBasisV2";
import type {
  ChronicleStageProvenanceClosureV1,
  ChronicleStageProvenanceReceiptRefV1,
  ChronicleStageTerminalReceiptV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";
import type { ExistingChronicleEventCatalogRecord } from "@/features/chronicle/extraction/existingEventMatcher";

export interface CreateRunTaskSeed {
  readonly taskId?: string;
  readonly taskKind: string;
  readonly inputJson?: Readonly<Record<string, unknown>>;
  readonly priority?: number;
}

export interface CreateRunPayload {
  readonly runId?: string;
  readonly projectId: string;
  readonly surfacePathId: string;
  readonly scopeJson: Readonly<Record<string, unknown>>;
  readonly specJson: Readonly<Record<string, unknown>>;
  readonly specDigest: string;
  readonly snapshotDigest?: string | null;
  readonly catalogDigest?: string | null;
  readonly registryDigest?: string | null;
  readonly coverageJson?: Readonly<Record<string, unknown>>;
  readonly tasks: readonly CreateRunTaskSeed[];
}

export interface CreateRunResult {
  readonly runId: string;
  readonly status: string;
  readonly taskIds: readonly string[];
}

/**
 * Exact process-local Native workspace authority captured before a
 * multi-await extraction operation starts. The persisted Workspace id alone
 * is insufficient because a clone/restore may intentionally retain it;
 * `generation` changes whenever the active Database authority is replaced.
 */
export interface NarrativeExtractionWorkspaceBinding {
  readonly authorityId: string;
  readonly generation: number;
  /** Opaque decimal u64; kept as text so JS cannot round the Native identity. */
  readonly authorityInstanceId: string;
}

export interface RunRefPayload {
  readonly runId: string;
  readonly projectId: string;
  readonly chronicleBlockedDiscard?: ChronicleBlockedDiscardExpectation;
}

export interface ChronicleBlockedDiscardExpectation {
  readonly nextTaskId: string;
  readonly blockedCode: string;
  readonly runSpecDigest: string;
  readonly snapshotDigest: string;
  readonly catalogDigest: string;
}

export interface ClaimTaskPayload {
  readonly runId: string;
  readonly projectId: string;
  readonly leaseOwner: string;
  readonly leaseDurationSecs?: number;
  readonly taskKinds?: readonly string[];
}

export interface ArtifactInput {
  readonly artifactId?: string;
  readonly artifactKind: string;
  readonly payloadStorage?: "inline-json" | "ref";
  readonly payloadJson?: Readonly<Record<string, unknown>>;
  readonly payloadRef?: string | null;
  readonly payloadDigest?: string | null;
}

export interface FinishTaskPayload {
  readonly runId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly leaseOwner: string;
  readonly outputJson?: Readonly<Record<string, unknown>>;
  readonly artifacts?: readonly ArtifactInput[];
  /**
   * Native-only C1 persistence proof. The closure is transport-ephemeral:
   * Native validates it and stores only verified terminal receipt/model rows.
   */
  readonly chronicleStageBundle?: ChronicleStageC1ExecutionBinding;
  /**
   * Task-local typed C1 receipts. Native verifies the finishing Task/Attempt
   * plus exact AI-audit evidence before retaining receipt/model rows. This
   * lets a later process resume after Observation completed but before the
   * synthesis closure could be assembled.
   */
  readonly chronicleStageReceipts?: readonly ChronicleStageTerminalReceiptV1[];
  readonly historicalScopeAuthorityBasis?: NarrativeScopeAuthorityBasisV2;
  /**
   * The terminal Chronicle ProposalSet is persisted with this plan Task in
   * one Native immediate transaction.  A separate save command would leave a
   * crash window where a durable review ledger exists but its owning Task is
   * still resumable.
   */
  readonly chroniclePlanProposalSet?: ChroniclePlanProposalSetFinish;
}

/**
 * C1 finish binding. `taskId`/`attemptId` name the closure aggregator (the
 * task being finished); `stageExecutionOwner*` identifies the actual model
 * stage whose prompt coordinates bind the aggregate proof. The distinction is
 * required in the multi-window Chronicle DAG.
 */
export interface ChronicleStageC1ExecutionBinding {
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly stageExecutionOwnerTaskId: string;
  readonly stageExecutionOwnerAttemptId: string;
  readonly stageExecutionOwnerStageExecutionId: string;
  readonly contextSetDigest: Sha256Digest;
  readonly componentContractDigest: Sha256Digest;
  readonly finalRequestDigest: Sha256Digest;
  readonly stageProvenanceClosureDigest: Sha256Digest;
  readonly closure: ChronicleStageProvenanceClosureV1;
}

export interface FailTaskPayload {
  readonly runId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly leaseOwner: string;
  readonly errorMessage: string;
  readonly outputJson?: Readonly<Record<string, unknown>>;
  readonly requeue?: boolean;
}

export interface ClaimedTask {
  readonly taskId: string;
  readonly runId: string;
  readonly taskKind: string;
  readonly status: string;
  readonly inputJson: Readonly<Record<string, unknown>>;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: string;
}

export interface ClaimTaskResult {
  readonly claimed: boolean;
  readonly task?: ClaimedTask;
}

export interface FinishTaskResult {
  readonly taskId: string;
  readonly attemptId: string;
  readonly status: string;
  /** Present only for the typed Chronicle plan terminalization route. */
  readonly proposalSet?: SaveProposalSetResult;
}

export interface ProposalSeed {
  readonly proposalId?: string;
  readonly proposalKey: string;
  readonly kind: string;
  readonly payloadJson: object;
  /** Optional V1 contract; omitted legacy revisions remain reviewable but cannot Apply. */
  readonly reconciliationEnvelope?:
    | ReconciliationEnvelopeV1
    | ReconciliationEnvelopeV2<unknown>;
}

export interface SaveProposalSetPayload {
  readonly runId: string;
  readonly projectId: string;
  readonly proposalSetId?: string;
  readonly setKind: string;
  readonly summaryJson?: Readonly<Record<string, unknown>>;
  readonly proposals: readonly ProposalSeed[];
}

/** Typed terminal companion for `chronicle.plan-proposals@1`. */
export interface ChroniclePlanProposalSetFinish {
  readonly proposalSet: SaveProposalSetPayload;
}

export type ChronicleStageReceiptRef = ChronicleStageProvenanceReceiptRefV1;

export interface SavedProposalSeed {
  readonly proposalId: string;
  readonly proposalKey: string;
  readonly revisionId: string;
  readonly status: NarrativeProposalStatus;
  readonly originKind?: "enveloped" | "legacy-unbound";
  readonly reconciliationEnvelopeDigest?: string | null;
  readonly reconciliationEnvelopeSchemaVersion?: 1 | 2 | null;
}

export interface SaveProposalSetResult {
  readonly proposalSetId: string;
  readonly proposals: readonly SavedProposalSeed[];
}

export interface ReviewBundleArtifact {
  readonly artifactId: string;
  readonly runId: string;
  readonly taskId: string | null;
  readonly attemptId: string | null;
  readonly artifactKind: string;
  readonly payloadStorage: "inline-json" | "ref" | string;
  readonly payloadJson: Readonly<Record<string, unknown>> | null;
  readonly payloadRef: string | null;
  readonly payloadDigest: string | null;
  readonly createdAt: string;
}

export interface ReviewBundleProposalSet {
  readonly proposalSetId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly setKind: string;
  readonly status: string;
  readonly summaryJson: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface ReviewBundleLatestDecision {
  readonly decisionId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly decision: NarrativeProposalDecision;
  readonly decisionJson: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly actorKind: "human" | "ai" | "system" | "unknown";
  readonly actorId: string;
  readonly authorityScope: string;
  readonly overrideFieldPaths: readonly string[];
}

export interface ReviewBundleProposalApplication {
  readonly commitId: string;
  readonly revisionId: string;
  readonly appliedEntityKind: string;
  readonly appliedEntityId: string;
  readonly createdAt: string;
  readonly applicationKind: "normal" | "compensation";
  readonly compensatesApplicationId: string | null;
}

export interface ReviewBundleProposal {
  readonly proposalId: string;
  readonly proposalSetId: string;
  readonly proposalKey: string;
  readonly kind: string;
  readonly status: NarrativeProposalStatus;
  readonly payloadJson: Readonly<Record<string, unknown>>;
  readonly currentRevisionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly originKind?: "enveloped" | "legacy-unbound";
  readonly reconciliationEnvelopeDigest?: string | null;
  readonly reconciliationEnvelopeSchemaVersion?: 1 | 2 | null;
  readonly latestDecision: ReviewBundleLatestDecision | null;
  /** Present when Native already applied this proposal (partial Apply / cold-start). */
  readonly application?: ReviewBundleProposalApplication | null;
}

/** Explicit CAS mode for carrying an existing envelope to a new revision. */
export interface ReconciliationEnvelopeInheritance {
  readonly parentRevisionId: string;
  readonly expectedEnvelopeDigest: string;
}

export interface GetRunReviewBundleResult {
  readonly runId: string;
  readonly projectId: string;
  readonly artifacts: readonly ReviewBundleArtifact[];
  /** Native-validated C1 terminal receipts for process-restart hydration. */
  readonly stageReceipts: readonly ChronicleStageTerminalReceiptV1[];
  readonly proposalSet: ReviewBundleProposalSet | null;
  readonly proposals: readonly ReviewBundleProposal[];
}

export interface AppendRevisionPayload {
  readonly runId: string;
  readonly projectId: string;
  readonly proposalId: string;
  readonly payloadJson: Readonly<Record<string, unknown>>;
  /** Optional V1 contract; omitted revisions are explicitly legacy-unbound. */
  readonly reconciliationEnvelope?:
    | ReconciliationEnvelopeV1
    | ReconciliationEnvelopeV2<unknown>;
  /** Optional explicit CAS inheritance; omission never inherits implicitly. */
  readonly inheritReconciliationEnvelope?: ReconciliationEnvelopeInheritance;
  /** Must match Native `current_revision_id` (OCC). */
  readonly expectedCurrentRevisionId: string;
  readonly createdBy?: string;
}

export interface AppendRevisionResult {
  readonly proposalId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly status: NarrativeProposalStatus;
}

export interface AppendDecisionPayload {
  readonly runId: string;
  readonly projectId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly decision: NarrativeProposalDecision;
  readonly decisionJson?: Readonly<Record<string, unknown>>;
  readonly createdBy?: string;
}

export interface AppendDecisionResult {
  readonly decisionId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly decision: NarrativeProposalDecision;
  readonly status: NarrativeProposalStatus;
}

export interface ReviseAndDecidePayload {
  readonly runId: string;
  readonly projectId: string;
  readonly proposalId: string;
  readonly payloadJson: Readonly<Record<string, unknown>>;
  readonly reconciliationEnvelope?:
    | ReconciliationEnvelopeV1
    | ReconciliationEnvelopeV2<unknown>;
  /** Optional explicit CAS inheritance; omission never inherits implicitly. */
  readonly inheritReconciliationEnvelope?: ReconciliationEnvelopeInheritance;
  /** Must match Native `current_revision_id` (OCC). */
  readonly expectedCurrentRevisionId: string;
  readonly decision: NarrativeProposalDecision;
  readonly decisionJson?: Readonly<Record<string, unknown>>;
  readonly createdBy?: string;
}

export interface ReviseAndDecideResult {
  readonly proposalId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly decisionId: string;
  readonly decision: NarrativeProposalDecision;
  readonly status: NarrativeProposalStatus;
}

/** Renderer-shaped C2B request; Native derives the material/Scope authority. */
export interface CreateHumanDerivedRevisionRequest {
  readonly proposalId: string;
  readonly expectedCurrentRevisionId: string;
  readonly parentRevisionId: string;
  readonly expectedParentEnvelopeDigest: string;
  readonly proposalPayload: Readonly<Record<string, unknown>>;
  readonly adapter: {
    readonly id: string;
    readonly version: string;
  };
  readonly surfaceId: string;
}

export interface CreateHumanDerivedRevisionPayload {
  /** Main supplies the project authority; it is not part of the C2B request. */
  readonly projectId: string;
  readonly request: CreateHumanDerivedRevisionRequest;
}

export interface CreateHumanDerivedRevisionResult {
  readonly proposalId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly originKind: "enveloped";
  readonly createdBy: string;
  readonly reconciliationEnvelopeDigest: string;
  readonly currentRevisionId: string;
  readonly status: NarrativeProposalStatus;
}

export interface HumanFieldLockPayload {
  readonly projectId: string;
  readonly entityKind: string;
  readonly entityId: string;
  readonly fieldPath: string;
  readonly expectedVersion: number;
  readonly locked: boolean;
}

export interface HumanFieldLockResult extends HumanFieldLockPayload {
  readonly version: number;
}

export interface CommitApplicationRef {
  readonly proposalId: string;
  readonly revisionId: string;
}

export interface CommitOperation {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly proposalId: string;
  readonly revisionId: string;
}

export interface EntityBindingSeed {
  readonly narrativeEntityId: string;
  readonly codexEntryId: string;
  readonly source?: "created" | "existing";
}

export interface PrepareCommitPayload {
  readonly projectId: string;
  readonly runId: string;
  readonly proposalSetId: string;
  readonly requestId: string;
  readonly planDigest: string;
  readonly sessionId: string;
  readonly surface?: string;
  readonly operations: readonly CommitOperation[];
  readonly applications: readonly CommitApplicationRef[];
  readonly expectedTailOrdinal?: string | null;
  readonly entityBindings?: readonly EntityBindingSeed[];
  readonly expectedCalendarVersion?: number;
}

export interface ApplyCommitPayload {
  readonly projectId: string;
  readonly preparedCommitId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly expectedVersion?: number | null;
}

export interface PrepareCommitResult {
  readonly ok: boolean;
  readonly preparedCommitId: string;
  readonly requestId: string;
  readonly planDigest: string;
  readonly authorityDigest?: string;
  readonly operationCount: number;
  readonly status?: string;
  readonly version?: number;
}

export interface ApplyCommitResult {
  readonly commitId: string;
  readonly requestId: string;
  readonly planDigest: string;
  readonly status: string;
  readonly journalId?: string;
  readonly changeEventUid?: string;
  /** Gate C0 freshness/invalidation feed correlation; not an audit ledger. */
  readonly maintenanceTransactionId?: string;
  readonly maintenanceOriginalTransactionId?: string;
  readonly maintenanceEventIds?: readonly string[];
  readonly created?: readonly {
    readonly operationIndex: number;
    readonly entityKind: string;
    readonly entityId: string;
    readonly version: number;
    readonly proposalId?: string | null;
    readonly revisionId?: string | null;
  }[];
  readonly entityBindings?: Readonly<
    Record<
      string,
      {
        readonly narrativeEntityId: string;
        readonly codexEntryId: string;
        readonly source: string;
      }
    >
  >;
  readonly idempotentReplay?: boolean;
}

export interface GetCommitStatusPayload {
  readonly projectId: string;
  readonly commitId?: string;
  readonly requestId?: string;
}

export interface GetCommitStatusResult {
  readonly found: boolean;
  readonly commitId?: string;
  readonly requestId?: string;
  readonly planDigest?: string;
  readonly status?: string;
  readonly receipt?: ApplyCommitResult | null;
  readonly errorMessage?: string | null;
  readonly createdAt?: string;
  readonly completedAt?: string | null;
  readonly version?: number;
}

export interface UndoCommitPayload {
  readonly projectId: string;
  readonly sessionId: string;
  readonly surface?: string;
  /** Exact applied commit being replayed. */
  readonly commitId: string;
  /** Stable identity of this undo or redo action; reuse only for its retry. */
  readonly requestId: string;
}

export interface ListResumableRunsPayload {
  readonly projectId: string;
  readonly surfacePathId?: string;
  readonly limit?: number;
}

export interface ResumableRunSummary {
  readonly runId: string;
  readonly projectId: string;
  readonly surfacePathId: string;
  readonly status: string;
  readonly snapshotDigest: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface ListChronicleTaskResumeCandidatesPayload {
  readonly projectId: string;
  readonly limit?: number;
}

export type ChronicleTaskResumeAvailability =
  | "ready"
  | "lease-held"
  | "blocked";

export interface ChronicleTaskResumeCandidate {
  readonly runId: string;
  readonly projectId: string;
  readonly status: "pending" | "running";
  readonly scopeJson: {
    readonly folderId: string;
    readonly sceneIds: readonly string[];
  };
  readonly specJson: Readonly<Record<string, unknown>>;
  readonly runSpecDigest: string;
  readonly snapshotDigest: string;
  readonly catalogDigest: string;
  readonly executionMode: "ai" | "deterministic-fallback";
  readonly coordinatorContractDigest: string;
  readonly completedTaskKinds: readonly string[];
  readonly nextTask: {
    readonly taskId: string;
    readonly taskKind: string;
    readonly status: "queued" | "running";
    readonly leaseExpiresAt: string | null;
  };
  readonly availability: ChronicleTaskResumeAvailability;
  readonly blockedCode: string | null;
  readonly language: string | null;
  readonly existingEventsCatalog: {
    readonly kind: "chronicle.existing-events-catalog@1";
    readonly events: readonly ExistingChronicleEventCatalogRecord[];
  } | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
}

function assertNarrativeExtractionWorkspaceBinding(
  value: NarrativeExtractionWorkspaceBinding,
): NarrativeExtractionWorkspaceBinding {
  if (
    typeof value.authorityId !== "string" ||
    value.authorityId.length === 0 ||
    value.authorityId.trim() !== value.authorityId ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    typeof value.authorityInstanceId !== "string" ||
    !/^[1-9][0-9]*$/u.test(value.authorityInstanceId)
  ) {
    throw new Error(
      "NEX_CHRONICLE_WORKSPACE_BINDING_INVALID: Native workspace binding is malformed",
    );
  }
  return {
    authorityId: value.authorityId,
    generation: value.generation,
    authorityInstanceId: value.authorityInstanceId,
  };
}

/**
 * Capture the exact active Native Database authority for a long-running
 * extraction. Native checks `expectedWorkspacePath` in the same operation,
 * so a renderer path captured from Workspace A can never be rebound to a
 * same-project Workspace B clone.
 */
export async function captureNarrativeExtractionWorkspaceBinding(
  expectedWorkspacePath: string,
): Promise<NarrativeExtractionWorkspaceBinding> {
  if (
    expectedWorkspacePath.length === 0 ||
    expectedWorkspacePath.trim() !== expectedWorkspacePath
  ) {
    throw new Error(
      "NEX_CHRONICLE_WORKSPACE_PATH_REQUIRED: an exact open Workspace path is required",
    );
  }
  return assertNarrativeExtractionWorkspaceBinding(
    await invoke<NarrativeExtractionWorkspaceBinding>(
      "narrative_extraction_capture_workspace_binding",
      { expectedWorkspacePath },
    ),
  );
}

export async function narrativeExtractionCreateRun(
  payload: CreateRunPayload,
  binding: NarrativeExtractionWorkspaceBinding,
): Promise<CreateRunResult> {
  const workspaceBinding = assertNarrativeExtractionWorkspaceBinding(binding);
  return invoke<CreateRunResult>("narrative_extraction_create_run", {
    payload,
    workspaceBinding,
  });
}

export async function narrativeExtractionGetRun(
  payload: RunRefPayload,
): Promise<NarrativeExtractionRunProjection> {
  return invoke<NarrativeExtractionRunProjection>(
    "narrative_extraction_get_run",
    { payload },
  );
}

export async function narrativeExtractionCancelRun(
  payload: RunRefPayload,
  binding: NarrativeExtractionWorkspaceBinding,
): Promise<{ runId: string; status: string }> {
  const workspaceBinding = assertNarrativeExtractionWorkspaceBinding(binding);
  return invoke<{ runId: string; status: string }>(
    "narrative_extraction_cancel_run",
    { payload, workspaceBinding },
  );
}

export async function narrativeExtractionClaimTask(
  payload: ClaimTaskPayload,
  binding: NarrativeExtractionWorkspaceBinding,
): Promise<ClaimTaskResult> {
  const workspaceBinding = assertNarrativeExtractionWorkspaceBinding(binding);
  return invoke<ClaimTaskResult>("narrative_extraction_claim_task", {
    payload,
    workspaceBinding,
  });
}

export async function narrativeExtractionFinishTask(
  payload: FinishTaskPayload,
  binding: NarrativeExtractionWorkspaceBinding,
): Promise<FinishTaskResult> {
  const workspaceBinding = assertNarrativeExtractionWorkspaceBinding(binding);
  return invoke<FinishTaskResult>("narrative_extraction_finish_task", {
    payload,
    workspaceBinding,
  });
}

export async function narrativeExtractionFailTask(
  payload: FailTaskPayload,
  binding: NarrativeExtractionWorkspaceBinding,
): Promise<FinishTaskResult> {
  const workspaceBinding = assertNarrativeExtractionWorkspaceBinding(binding);
  return invoke<FinishTaskResult>("narrative_extraction_fail_task", {
    payload,
    workspaceBinding,
  });
}

export async function narrativeExtractionSaveProposalSet(
  payload: SaveProposalSetPayload,
  binding: NarrativeExtractionWorkspaceBinding,
): Promise<SaveProposalSetResult> {
  const workspaceBinding = assertNarrativeExtractionWorkspaceBinding(binding);
  return invoke<SaveProposalSetResult>(
    "narrative_extraction_save_proposal_set",
    { payload, workspaceBinding },
  );
}

export async function narrativeExtractionGetRunReviewBundle(
  payload: RunRefPayload,
): Promise<GetRunReviewBundleResult> {
  return invoke<GetRunReviewBundleResult>(
    "narrative_extraction_get_run_review_bundle",
    { payload },
  );
}

export async function narrativeExtractionAppendRevision(
  payload: AppendRevisionPayload,
): Promise<AppendRevisionResult> {
  return invoke<AppendRevisionResult>("narrative_extraction_append_revision", {
    payload,
  });
}

export async function narrativeExtractionAppendDecision(
  payload: AppendDecisionPayload,
): Promise<AppendDecisionResult> {
  return invoke<AppendDecisionResult>("narrative_extraction_append_decision", {
    payload,
  });
}

/** Human review endpoint; Native fixes the actor class and review scope. */
export async function narrativeExtractionAppendHumanDecision(
  payload: AppendDecisionPayload,
): Promise<AppendDecisionResult> {
  return invoke<AppendDecisionResult>(
    "narrative_extraction_append_human_decision",
    { payload },
  );
}

export async function narrativeExtractionReviseAndDecide(
  payload: ReviseAndDecidePayload,
): Promise<ReviseAndDecideResult> {
  return invoke<ReviseAndDecideResult>(
    "narrative_extraction_revise_and_decide",
    { payload },
  );
}

/** Atomic human revision + decision endpoint for the review surface. */
export async function narrativeExtractionReviseAndDecideAsHuman(
  payload: ReviseAndDecidePayload,
): Promise<ReviseAndDecideResult> {
  return invoke<ReviseAndDecideResult>(
    "narrative_extraction_revise_and_decide_as_human",
    { payload },
  );
}

/** Native-owned C2B writer for Chronicle Human title/secret edits. */
export async function narrativeExtractionCreateHumanDerivedRevision(
  payload: CreateHumanDerivedRevisionPayload,
): Promise<CreateHumanDerivedRevisionResult> {
  return invoke<CreateHumanDerivedRevisionResult>(
    "narrative_extraction_create_human_derived_revision",
    { payload },
  );
}

export const createHumanDerivedNarrativeRevisionV2 =
  narrativeExtractionCreateHumanDerivedRevision;

export async function narrativeExtractionSetHumanFieldLock(
  payload: HumanFieldLockPayload,
): Promise<HumanFieldLockResult> {
  return invoke<HumanFieldLockResult>(
    "narrative_extraction_set_human_field_lock",
    { payload },
  );
}

export async function narrativeExtractionPrepareCommit(
  payload: PrepareCommitPayload,
): Promise<PrepareCommitResult> {
  return invoke<PrepareCommitResult>("narrative_extraction_prepare_commit", {
    payload,
  });
}

export async function narrativeExtractionApplyCommit(
  payload: ApplyCommitPayload,
): Promise<ApplyCommitResult> {
  return invoke<ApplyCommitResult>("narrative_extraction_apply_commit", {
    payload,
  });
}

export async function narrativeExtractionGetCommitStatus(
  payload: GetCommitStatusPayload,
): Promise<GetCommitStatusResult> {
  return invoke<GetCommitStatusResult>(
    "narrative_extraction_get_commit_status",
    { payload },
  );
}

export async function narrativeExtractionUndoCommit(
  payload: UndoCommitPayload,
): Promise<ApplyCommitResult> {
  return invoke<ApplyCommitResult>("narrative_extraction_undo_commit", {
    payload,
  });
}

export async function narrativeExtractionRedoCommit(
  payload: UndoCommitPayload,
): Promise<ApplyCommitResult> {
  return invoke<ApplyCommitResult>("narrative_extraction_redo_commit", {
    payload,
  });
}

export async function narrativeExtractionListResumableRuns(
  payload: ListResumableRunsPayload,
): Promise<readonly ResumableRunSummary[]> {
  return invoke<readonly ResumableRunSummary[]>(
    "narrative_extraction_list_resumable_runs",
    { payload },
  );
}

export async function narrativeExtractionListChronicleTaskResumeCandidates(
  payload: ListChronicleTaskResumeCandidatesPayload,
): Promise<readonly ChronicleTaskResumeCandidate[]> {
  return invoke<readonly ChronicleTaskResumeCandidate[]>(
    "narrative_extraction_list_chronicle_task_resume_candidates",
    { payload },
  );
}
