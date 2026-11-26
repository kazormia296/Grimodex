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

/**
 * Native's bulk-approval judgement for one proposal (BAO/1). Present for
 * current Chronicle reviews only; the review screen shows it and never
 * computes the condition itself.
 */
export type ChronicleBulkApprovalReasonCode =
  | "approved"
  | "rejected"
  | "held"
  | "deferred"
  | "status-other"
  | "applied"
  | "set-applied"
  | "edited"
  | "probable-duplicate"
  | "plan-unavailable"
  | "evidence-unverified"
  | "r0-material-unavailable"
  | "r1-narrative-frame"
  | "r2-attribution"
  | "r3-significance"
  | "r4-actuality"
  | "already-nonsecret"
  | "reveal-scene-unresolved"
  | "scope-authority-unavailable"
  | "semantic-epoch-missing"
  | "parent-seal-missing"
  | "proposal-not-found"
  | "revision-changed";

export interface ChronicleBulkApproval {
  readonly eligible: boolean;
  readonly reasons: readonly ChronicleBulkApprovalReasonCode[];
}

export interface ReviewBundleProposal extends Partial<RedecideStatus> {
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
  /** Native's bulk-approval judgement; current Chronicle reviews only. */
  readonly bulkApproval?: ChronicleBulkApproval;
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

export interface IsRunResumableForReviewPayload {
  readonly runId: string;
  readonly projectId: string;
  readonly surfacePathId: string;
}

export interface IsRunResumableForReviewResult {
  readonly runId: string;
  readonly projectId: string;
  readonly surfacePathId: string;
  readonly resumable: boolean;
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

export interface CodexCatalogRevision {
  readonly sourceKind: "codex-catalog";
  readonly sourceKey: string;
  readonly revisionToken: string;
}

/**
 * The Native revision token of the Project's Codex catalog Source
 * (`project:codex-catalog:<projectId>`), computed by the resolver that checks
 * a ReadSet on save and Apply (DR-CSX-1). Renderer code must not derive it.
 */
export async function narrativeExtractionResolveCodexCatalogRevision(
  payload: { readonly projectId: string },
  binding: NarrativeExtractionWorkspaceBinding,
): Promise<CodexCatalogRevision> {
  const workspaceBinding = assertNarrativeExtractionWorkspaceBinding(binding);
  return invoke<CodexCatalogRevision>(
    "narrative_extraction_resolve_codex_catalog_revision",
    { payload: { projectId: payload.projectId }, workspaceBinding },
  );
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

/**
 * Chronicle "bulk approve" (BAO/1): per proposal, one Native transaction that
 * writes the unsealed Human-derived child and its Human approval. The Chronicle
 * review screen's "bulk approve" button calls it with the Native-judged targets.
 */
export async function narrativeExtractionChronicleBulkApprove(
  payload: ChronicleBulkApprovePayload,
): Promise<ChronicleBulkApproveResult> {
  return invoke<ChronicleBulkApproveResult>(
    "narrative_extraction_chronicle_bulk_approve",
    { payload },
  );
}

/** Reapprove an applied proposal after its Chronicle event was removed. */
export async function narrativeExtractionReapproveAppliedProposals(
  payload: ReapproveAppliedProposalsPayload,
): Promise<ReapproveAppliedProposalsResult> {
  return invoke<ReapproveAppliedProposalsResult>(
    "narrative_extraction_reapprove_applied_proposals",
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

export interface ChronicleBulkApproveTarget {
  readonly proposalId: string;
  /** The proposal's current revision the author was shown. */
  readonly revisionId: string;
}

/**
 * The author-shown targets only. Native judges each one again; it takes no
 * content, secret value, actor or request identity from the renderer.
 */
export interface ChronicleBulkApprovePayload {
  readonly projectId: string;
  readonly runId: string;
  readonly targets: readonly ChronicleBulkApproveTarget[];
}

export interface ChronicleBulkApproveResult {
  /** `revisionId` is the new Human-derived (unsealed) child that was approved. */
  readonly approved: readonly {
    readonly proposalId: string;
    readonly revisionId: string;
    readonly decisionId: string;
  }[];
  /** Not (or no longer) a target; nothing was written for these. */
  readonly skipped: readonly {
    readonly proposalId: string;
    readonly reasons: readonly ChronicleBulkApprovalReasonCode[];
  }[];
  /** Rolled back as a whole; `code` is the stable `NEX_...` error code. */
  readonly failed: readonly {
    readonly proposalId: string;
    readonly code: string;
  }[];
  /** Shutdown or a workspace switch stopped the run between proposals. */
  readonly stopped: boolean;
}

export type ReapproveAppliedProposalSkipReasonCode =
  | "proposal-not-found"
  | "no-application"
  | "revision-changed"
  | "already-approved"
  | "not-removal-rejection"
  | "event-missing";

export interface ReapproveAppliedProposalsPayload {
  readonly projectId: string;
  readonly targets: readonly {
    readonly proposalId: string;
    readonly revisionId: string;
  }[];
}

export interface ReapproveAppliedProposalsResult {
  readonly approved: readonly {
    readonly proposalId: string;
    readonly revisionId: string;
    readonly decisionId: string;
  }[];
  readonly skipped: readonly {
    readonly proposalId: string;
    readonly reasons: readonly ReapproveAppliedProposalSkipReasonCode[];
  }[];
  readonly failed: readonly {
    readonly proposalId: string;
    readonly code: string;
  }[];
  readonly stopped: boolean;
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

export async function narrativeExtractionIsRunResumableForReview(
  payload: IsRunResumableForReviewPayload,
): Promise<IsRunResumableForReviewResult> {
  return invoke<IsRunResumableForReviewResult>(
    "narrative_extraction_is_run_resumable_for_review",
    { payload },
  );
}

/**
 * The Scene -> Proposals read (SRA/1 R1-R3). `limit` above Native's cap
 * (`SCENE_PROPOSALS_PAGE_MAX`, 50) is cut to it; the applied size comes back
 * as `limit` on the page.
 */
export interface ListSceneProposalsPayload {
  readonly projectId: string;
  readonly sceneId: string;
  /** The previous page's `nextCursor`; absent for the first page. */
  readonly cursor?: string;
  readonly limit?: number;
}

export type SceneProposalReviewState =
  | "unreviewed"
  | "approved"
  | "rejected"
  | "held"
  | "deferred"
  | "other";

/** The state of the Sources the revision was read from. */
export type SceneProposalSourceState = "fresh" | "stale" | "unknown";

/** Whether the proposal's current revision is in the Chronicle. */
export type SceneProposalChronicleState = "not-applied" | "applied";

/** The sealed duplicate judgement of extraction time (`unknown`: plan unreadable). */
export type SceneProposalDuplicateSuspicion = "none" | "probable" | "unknown";

/**
 * Why a revision stays out of Related Scenes whatever Scene is being written.
 * Native's wording, shown as is; never computed by the screen.
 */
export type SceneProposalReasonCode =
  | "not-approved"
  | "material-unavailable"
  | "binding-invalid"
  | "secret"
  | "contract-unclassified"
  | "scope-control-unclassified"
  | "material-authority-unavailable"
  | "scope-unresolved"
  | "scope-unsupported"
  | "evidence-mismatch"
  | "source-stale"
  | "source-unverified"
  | "scene-dependent";

export interface SceneProposalEvidence {
  /** The Scene the quote is from (the requested Scene). */
  readonly sceneId: string;
  /** The quote the revision's sealed record holds; never the Scene body. */
  readonly quote: string;
}

export interface SceneProposalRelatedUse {
  /** No static reason keeps the revision out of Related Scenes. */
  readonly likely: boolean;
  readonly reasons: readonly SceneProposalReasonCode[];
}

export interface RedecideStatus {
  readonly rejectedBy: "event-removed" | null;
  readonly removedVia:
    | "screen-delete"
    | "undo-redo"
    | "snapshot-restore"
    | "commit-undo"
    | "mcp-delete"
    | "agent-delete"
    | null;
  readonly rejectedAt: string | null;
  readonly reapproval: {
    readonly available: boolean;
    readonly reason: ReapproveAppliedProposalSkipReasonCode | null;
  };
}

export interface SceneProposalItem extends RedecideStatus {
  readonly proposalId: string;
  /** The proposal's current revision. */
  readonly revisionId: string;
  readonly title: string | null;
  /** This Scene's evidence quotes (at most 16). */
  readonly evidence: readonly SceneProposalEvidence[];
  readonly evidenceTruncated: boolean;
  /** The other Scenes the evidence spans, sorted. */
  readonly otherSceneIds: readonly string[];
  readonly reviewState: SceneProposalReviewState;
  readonly sourceState: SceneProposalSourceState;
  readonly chronicleState: SceneProposalChronicleState;
  readonly probableDuplicate: SceneProposalDuplicateSuspicion;
  readonly relatedUse: SceneProposalRelatedUse;
}

export interface SceneProposalPage {
  readonly items: readonly SceneProposalItem[];
  /** Pass it back as `cursor`; null on the last page. */
  readonly nextCursor: string | null;
  /** The page size Native applied. */
  readonly limit: number;
}

export async function narrativeExtractionListSceneProposals(
  payload: ListSceneProposalsPayload,
): Promise<SceneProposalPage> {
  return invoke<SceneProposalPage>(
    "narrative_extraction_list_scene_proposals",
    {
      payload,
    },
  );
}

export type ListRedecidableProposalsPayload = Omit<
  ListSceneProposalsPayload,
  "sceneId"
>;

export interface RedecidableProposalItem {
  readonly proposalId: string;
  readonly revisionId: string;
  readonly title: string | null;
  readonly evidenceSceneIds: readonly string[];
  readonly evidenceSceneIdsTruncated: boolean;
  readonly rejectedAt: string;
  readonly removedVia: RedecideStatus["removedVia"];
}

export interface RedecidableProposalPage {
  readonly items: readonly RedecidableProposalItem[];
  readonly total: number;
  readonly nextCursor: string | null;
  readonly limit: number;
}

export async function narrativeExtractionListRedecidableProposals(
  payload: ListRedecidableProposalsPayload,
): Promise<RedecidableProposalPage> {
  return invoke<RedecidableProposalPage>(
    "narrative_extraction_list_redecidable_proposals",
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

/**
 * Closed vocabularies the maintenance Inbox wire is read against. A value
 * outside them becomes `"unrecognized"` instead of being guessed at
 * (fail-closed): the structure-health counts never fold an unknown value into
 * a known bucket.
 */
export const MAINTENANCE_INBOX_ENTRY_KINDS = [
  "consumer-freshness",
  "terminal-failure",
] as const;
/**
 * Known `consumer_kind` strings. Copied from `consumerKinds` in
 * policies/narrative/narrative-consumer-contract.json (declared, reserved and
 * not-yet-modelled alike, 11 kinds) plus the synthetic
 * `narrative-maintenance-failure` of terminal-failure rows. Native does not
 * validate the vocabulary, so a string outside this set becomes
 * `"unrecognized"` and is counted as an unreadable item, never dropped.
 * nativeApi.maintenanceInbox.test.ts pins this list against the contract.
 */
export const MAINTENANCE_INBOX_CONSUMER_KINDS = [
  "narrative-extraction-run",
  "proposal-revision",
  "extraction-artifact",
  "application",
  "application-contribution",
  "derived-projection",
  "semantic-index",
  "narrative-ir-revision",
  "related-scenes-materialization",
  "chat-context-materialization",
  "structure-health-diagnostic",
  "narrative-maintenance-failure",
] as const;
export const MAINTENANCE_INBOX_EVIDENCE_FRESHNESS = [
  "fresh",
  "stale",
  "source-missing",
  "anchor-mismatch",
  "read-set-drift",
  "unknown",
] as const;

export type MaintenanceInboxEntryKind =
  | (typeof MAINTENANCE_INBOX_ENTRY_KINDS)[number]
  | "unrecognized";
export type MaintenanceInboxConsumerKind =
  | (typeof MAINTENANCE_INBOX_CONSUMER_KINDS)[number]
  | "unrecognized";
/** `null`: the row carries no freshness (a terminal-failure row). */
export type MaintenanceInboxEvidenceFreshness =
  | (typeof MAINTENANCE_INBOX_EVIDENCE_FRESHNESS)[number]
  | "unrecognized"
  | null;

/**
 * Allow-listed Inbox fields exposed to renderer callers.
 * Free text (`attention.reason`), actor / request identities, payload digests
 * and observation rows ride on the wire but are deliberately never read here.
 */
export interface MaintenanceInboxEntry {
  readonly entryKind: MaintenanceInboxEntryKind;
  readonly consumerKind: MaintenanceInboxConsumerKind;
  readonly evidenceFreshness: MaintenanceInboxEvidenceFreshness;
  readonly attentionApplies: boolean;
}

function pickKnown<const T extends readonly string[]>(
  value: unknown,
  known: T,
): T[number] | "unrecognized" {
  return typeof value === "string" &&
    (known as readonly string[]).includes(value)
    ? (value as T[number])
    : "unrecognized";
}

/**
 * Validate the snake_case Inbox wire and project it onto the allow-listed
 * camelCase shape. Throws when the wire is not an array; an element that is
 * not an object, or a vocabulary field that is missing or unknown, becomes
 * `"unrecognized"` rather than an error.
 */
export function parseMaintenanceInbox(
  raw: unknown,
): readonly MaintenanceInboxEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error("narrative_maintenance_inbox_list: expected an array");
  }
  return raw.map((row: unknown): MaintenanceInboxEntry => {
    const record =
      typeof row === "object" && row !== null
        ? (row as Readonly<Record<string, unknown>>)
        : {};
    const entryKind = pickKnown(
      record["entry_kind"],
      MAINTENANCE_INBOX_ENTRY_KINDS,
    );
    return {
      entryKind,
      consumerKind: pickKnown(
        record["consumer_kind"],
        MAINTENANCE_INBOX_CONSUMER_KINDS,
      ),
      // A terminal-failure row has no freshness by construction; ignore
      // whatever the wire carries for it.
      evidenceFreshness:
        entryKind === "terminal-failure"
          ? null
          : pickKnown(
              record["evidence_freshness"],
              MAINTENANCE_INBOX_EVIDENCE_FRESHNESS,
            ),
      attentionApplies: record["attention_applies"] === true,
    };
  });
}

/**
 * Read-only list of what maintenance is watching, for the structure-health
 * counts. Sends only `{ projectId }`; Native stamps the clock itself.
 */
export async function narrativeMaintenanceInboxList(payload: {
  readonly projectId: string;
}): Promise<readonly MaintenanceInboxEntry[]> {
  const raw = await invoke<unknown>("narrative_maintenance_inbox_list", {
    payload: { projectId: payload.projectId },
  });
  return parseMaintenanceInbox(raw);
}

/** Read-only count of stale proposals for the Work Layer header. */
export async function narrativeMaintenanceStaleProposalCount(payload: {
  readonly projectId: string;
}): Promise<number> {
  const raw = await invoke<unknown>(
    "narrative_maintenance_stale_proposal_count",
    { payload: { projectId: payload.projectId } },
  );
  if (
    raw === null ||
    typeof raw !== "object" ||
    !Number.isSafeInteger((raw as { count?: unknown }).count) ||
    (raw as { count: number }).count < 0
  ) {
    throw new Error(
      "narrative_maintenance_stale_proposal_count: expected a non-negative safe integer count",
    );
  }
  return (raw as { count: number }).count;
}

export type MaintenanceHealthFreshness =
  | "stale"
  | "source-missing"
  | "anchor-mismatch"
  | "read-set-drift"
  | "unknown";

export interface MaintenanceHealthSummary {
  readonly proposalsChecked: number;
  readonly proposalsStale: number;
  readonly staleBreakdown: Record<MaintenanceHealthFreshness, number>;
  readonly maintenanceStopped: number;
  readonly unrecognized: number;
}

/** Read aggregate maintenance health counts without loading Inbox rows. */
export async function narrativeMaintenanceHealthSummary(payload: {
  readonly projectId: string;
}): Promise<MaintenanceHealthSummary> {
  const command = "narrative_maintenance_health_summary";
  const raw = await invoke<unknown>(command, {
    payload: { projectId: payload.projectId },
  });
  const isRecord = (
    value: unknown,
  ): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const freshnessKinds: readonly MaintenanceHealthFreshness[] = [
    "stale",
    "source-missing",
    "anchor-mismatch",
    "read-set-drift",
    "unknown",
  ];
  if (!isRecord(raw) || !isRecord(raw.staleBreakdown)) {
    throw new Error(`${command}: expected non-negative safe-integer counts`);
  }
  const staleBreakdown = raw.staleBreakdown;
  if (
    !Number.isSafeInteger(raw.proposalsChecked) ||
    (raw.proposalsChecked as number) < 0 ||
    !Number.isSafeInteger(raw.proposalsStale) ||
    (raw.proposalsStale as number) < 0 ||
    !Number.isSafeInteger(raw.maintenanceStopped) ||
    (raw.maintenanceStopped as number) < 0 ||
    !Number.isSafeInteger(raw.unrecognized) ||
    (raw.unrecognized as number) < 0 ||
    freshnessKinds.some(
      (kind) =>
        !Number.isSafeInteger(staleBreakdown[kind]) ||
        (staleBreakdown[kind] as number) < 0,
    )
  ) {
    throw new Error(`${command}: expected non-negative safe-integer counts`);
  }
  return {
    proposalsChecked: raw.proposalsChecked as number,
    proposalsStale: raw.proposalsStale as number,
    staleBreakdown: Object.fromEntries(
      freshnessKinds.map((kind) => [kind, staleBreakdown[kind] as number]),
    ) as Record<MaintenanceHealthFreshness, number>,
    maintenanceStopped: raw.maintenanceStopped as number,
    unrecognized: raw.unrecognized as number,
  };
}

export interface StaleProposalSceneCount {
  readonly sceneId: string;
  readonly proposalCount: number;
}

export interface StaleProposalScenesPage {
  readonly scenes: readonly StaleProposalSceneCount[];
  readonly withoutSceneCount: number;
  readonly nextCursor?: string;
}

/** Read-only scene counts for stale proposals in one project. */
export async function narrativeMaintenanceStaleProposalScenes(payload: {
  readonly projectId: string;
  readonly cursor?: string;
  readonly limit?: number;
}): Promise<StaleProposalScenesPage> {
  const raw = await invoke<unknown>(
    "narrative_maintenance_stale_proposal_scenes",
    { payload },
  );
  const isRecord = (
    value: unknown,
  ): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.scenes) ||
    !Number.isSafeInteger(raw.withoutSceneCount) ||
    (raw.withoutSceneCount as number) < 0 ||
    (raw.nextCursor !== undefined &&
      (typeof raw.nextCursor !== "string" || raw.nextCursor.length === 0))
  ) {
    throw new Error(
      "narrative_maintenance_stale_proposal_scenes: expected a scene-count page",
    );
  }

  const scenes = raw.scenes.map((scene): StaleProposalSceneCount => {
    if (
      !isRecord(scene) ||
      typeof scene.sceneId !== "string" ||
      scene.sceneId.length === 0 ||
      !Number.isSafeInteger(scene.proposalCount) ||
      (scene.proposalCount as number) < 1
    ) {
      throw new Error(
        "narrative_maintenance_stale_proposal_scenes: expected scene counts",
      );
    }
    return {
      sceneId: scene.sceneId,
      proposalCount: scene.proposalCount as number,
    };
  });
  const nextCursor = raw.nextCursor as string | undefined;
  return {
    scenes,
    withoutSceneCount: raw.withoutSceneCount as number,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}
