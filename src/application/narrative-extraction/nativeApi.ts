import { invoke } from "@/lib/tauri";

import type {
  NarrativeExtractionRunProjection,
  NarrativeProposalDecision,
  NarrativeProposalStatus,
} from "@/features/narrative-extraction/runtime/types";
import type { ReconciliationEnvelopeV1 } from "@/features/narrative-extraction/reconciler/types";

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

export interface RunRefPayload {
  readonly runId: string;
  readonly projectId: string;
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
}

export interface ProposalSeed {
  readonly proposalId?: string;
  readonly proposalKey: string;
  readonly kind: string;
  readonly payloadJson: object;
  /** Optional V1 contract; omitted legacy revisions remain reviewable but cannot Apply. */
  readonly reconciliationEnvelope?: ReconciliationEnvelopeV1;
}

export interface SaveProposalSetPayload {
  readonly runId: string;
  readonly projectId: string;
  readonly proposalSetId?: string;
  readonly setKind: string;
  readonly summaryJson?: Readonly<Record<string, unknown>>;
  readonly proposals: readonly ProposalSeed[];
}

export interface SavedProposalSeed {
  readonly proposalId: string;
  readonly proposalKey: string;
  readonly revisionId: string;
  readonly status: NarrativeProposalStatus;
  readonly originKind?: "enveloped" | "legacy-unbound";
  readonly reconciliationEnvelopeDigest?: string | null;
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
  readonly proposalSet: ReviewBundleProposalSet | null;
  readonly proposals: readonly ReviewBundleProposal[];
}

export interface AppendRevisionPayload {
  readonly runId: string;
  readonly projectId: string;
  readonly proposalId: string;
  readonly payloadJson: Readonly<Record<string, unknown>>;
  /** Optional V1 contract; omitted revisions are explicitly legacy-unbound. */
  readonly reconciliationEnvelope?: ReconciliationEnvelopeV1;
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
  readonly reconciliationEnvelope?: ReconciliationEnvelopeV1;
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
  readonly commitId?: string;
  readonly requestId?: string;
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

export async function narrativeExtractionCreateRun(
  payload: CreateRunPayload,
): Promise<CreateRunResult> {
  return invoke<CreateRunResult>("narrative_extraction_create_run", {
    payload,
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
): Promise<{ runId: string; status: string }> {
  return invoke<{ runId: string; status: string }>(
    "narrative_extraction_cancel_run",
    { payload },
  );
}

export async function narrativeExtractionClaimTask(
  payload: ClaimTaskPayload,
): Promise<ClaimTaskResult> {
  return invoke<ClaimTaskResult>("narrative_extraction_claim_task", {
    payload,
  });
}

export async function narrativeExtractionFinishTask(
  payload: FinishTaskPayload,
): Promise<FinishTaskResult> {
  return invoke<FinishTaskResult>("narrative_extraction_finish_task", {
    payload,
  });
}

export async function narrativeExtractionFailTask(
  payload: FailTaskPayload,
): Promise<FinishTaskResult> {
  return invoke<FinishTaskResult>("narrative_extraction_fail_task", {
    payload,
  });
}

export async function narrativeExtractionSaveProposalSet(
  payload: SaveProposalSetPayload,
): Promise<SaveProposalSetResult> {
  return invoke<SaveProposalSetResult>(
    "narrative_extraction_save_proposal_set",
    { payload },
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

export async function narrativeExtractionReviseAndDecide(
  payload: ReviseAndDecidePayload,
): Promise<ReviseAndDecideResult> {
  return invoke<ReviseAndDecideResult>(
    "narrative_extraction_revise_and_decide",
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
