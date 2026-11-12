import type { MutationAuthority } from "@/features/concurrency/mutationAuthority";
import type {
  ChronicleExistingMatch,
  ExistingChronicleEventCatalogRecord,
} from "./extraction/existingEventMatcher";
import { create } from "zustand";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import type {
  NarrativeExtractionRunStatus,
  NarrativeExtractionTaskCounts,
  NarrativeProposalStatus,
} from "@/features/narrative-extraction/runtime/types";
import type {
  ChronicleBulkApproval,
  ChronicleTaskResumeCandidate,
  ReviewBundleProposalApplication,
} from "@/application/narrative-extraction/nativeApi";
import type { NarrativeSceneScopeMode } from "@/application/narrative-extraction/projectSnapshotAdapter";

export interface StartChronicleExtractionRequest {
  readonly projectId: string;
  readonly folderId: string;
  readonly language?: string;
  readonly sceneIds: readonly string[];
  readonly authority: MutationAuthority;
  readonly workspacePath: string;
  readonly openRevision: number;
  readonly existingEvents?: readonly ExistingChronicleEventCatalogRecord[];
  readonly useAi?: boolean;
  /**
   * Omitted is `folder-exact` (the folder's every Scene must be requested).
   * `requested-direct-children` checks only the requested Scenes, which must be
   * direct children of `folderId`. Passed through to the Snapshot adapter only;
   * never stored in the Run scope or spec.
   */
  readonly sceneScopeMode?: NarrativeSceneScopeMode;
}

export type ProbableDuplicateChoice = "skip-as-same" | "create-as-new" | "hold";

export interface ChronicleExtractionCoverageGap {
  readonly windowId?: string;
  readonly sourceRef?: string;
  readonly reason: string;
}

export interface ChronicleExtractionCoverage {
  readonly mode?: string;
  readonly documentCount?: number;
  readonly windowCount?: number;
  readonly completedWindows?: number;
  readonly gaps?: readonly ChronicleExtractionCoverageGap[];
}

/**
 * Plan-time evidence/duplicate flags. They are display/diagnostic data only:
 * "bulk approve" targets are decided by Native (`bulkApproval`, BAO/1), never
 * by these flags.
 */
export interface ChronicleProposalSafetyFlags {
  readonly fresh: boolean;
  readonly evidenceExact: boolean;
  readonly actualitySettled: boolean;
  readonly noDuplicate: boolean;
  readonly lossless: boolean;
  readonly noDeps: boolean;
  readonly riskLow: boolean;
}

export interface ChronicleReviewEvidenceQuote {
  readonly anchorId: string;
  readonly quote: string;
  readonly documentRef: string;
  readonly sceneId?: string;
  readonly sceneTitle?: string;
  readonly method: "exact" | "exact-with-context" | "fragmented" | "unknown";
  /** fragmented evidence is reviewable but blocks apply in v1. */
  readonly blocked?: boolean;
}

export interface ChronicleReviewProposal {
  readonly proposalId: string;
  readonly revisionId: string | null;
  readonly reconciliationEnvelopeDigest?: string | null;
  readonly reconciliationEnvelopeSchemaVersion?: 1 | 2 | null;
  readonly proposalKey: string;
  readonly status: NarrativeProposalStatus;
  /** already-satisfied entries are completed / not applicable. */
  readonly applicability: "applicable" | "already-satisfied";
  readonly displayTitle: string;
  readonly payload: CreateChronicleEventProposalPayloadV1 | null;
  /** Immutable Run-sealed title used to classify human title revisions. */
  readonly plannedTitle: string;
  /** Immutable Run-sealed match restored by an exact title revert. */
  readonly plannedMatch: ChronicleExistingMatch;
  readonly match: ChronicleExistingMatch;
  readonly evidence: readonly ChronicleReviewEvidenceQuote[];
  readonly safety: ChronicleProposalSafetyFlags;
  readonly probableDuplicateChoice: ProbableDuplicateChoice | null;
  /** Native application proof. Non-null proposals are immutable/read-only. */
  readonly application: ReviewBundleProposalApplication | null;
  readonly blockedReason?: string;
  /**
   * Native's bulk-approval judgement (BAO/1, B3). `null`/absent means "not
   * received (yet)", a Run without a judgement, or a read that failed: such a
   * proposal is never counted as, or sent as, a bulk-approval target.
   */
  readonly bulkApproval?: ChronicleBulkApproval | null;
}

/** Native's judgement is the only source of "is a bulk-approval target". */
export function isBulkApprovalTarget(
  proposal: Pick<
    ChronicleReviewProposal,
    "applicability" | "application" | "revisionId" | "bulkApproval"
  >,
): boolean {
  return (
    proposal.applicability === "applicable" &&
    proposal.application === null &&
    proposal.revisionId !== null &&
    proposal.bulkApproval?.eligible === true
  );
}

/** Identity of the review projection an async result was computed for. */
export interface ChronicleReviewProjectionIdentity {
  readonly runId: string;
  readonly projectId: string;
  readonly workspacePath: string | null;
  readonly openRevision: number | null;
}

/** Native fields that replace the local copy after a bulk approval. */
export interface ChronicleNativeRevisionSync {
  readonly revisionId: string;
  readonly status: NarrativeProposalStatus;
  readonly payload: CreateChronicleEventProposalPayloadV1;
  readonly reconciliationEnvelopeDigest: string | null;
  readonly reconciliationEnvelopeSchemaVersion: 1 | 2 | null;
}

export interface ChronicleNativeReviewRow {
  readonly proposalId: string;
  readonly bulkApproval: ChronicleBulkApproval | null;
  /** Present only when the caller wants the revision/status copied too. */
  readonly sync?: ChronicleNativeRevisionSync;
}

export type ChronicleApplyPreflightErrorCode =
  | "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE"
  | "NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH";

export interface ChronicleApplyReadiness {
  readonly ready: boolean;
  readonly approvedCount: number;
  readonly errorCode: ChronicleApplyPreflightErrorCode | null;
}

/**
 * Current Chronicle @2 uses one atomic review decision boundary: every
 * Native/applicable, unapplied proposal must be approved or rejected before
 * any approved proposal may be committed. held/deferred remain unresolved.
 */
export function getChronicleApplyReadiness(
  proposals: readonly ChronicleReviewProposal[],
): ChronicleApplyReadiness {
  const durable = proposals.filter(
    (proposal) => proposal.applicability === "applicable",
  );
  const unapplied = durable.filter((proposal) => proposal.application === null);
  const hasInvalidApplication = durable.some(
    (proposal) =>
      proposal.application !== null &&
      proposal.application.revisionId !== proposal.revisionId,
  );
  const hasPriorApplication = durable.some(
    (proposal) => proposal.application !== null,
  );
  if (hasInvalidApplication || (hasPriorApplication && unapplied.length > 0)) {
    return {
      ready: false,
      approvedCount: 0,
      errorCode: "NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH",
    };
  }
  if (
    unapplied.some(
      (proposal) =>
        proposal.status !== "approved" && proposal.status !== "rejected",
    )
  ) {
    return {
      ready: false,
      approvedCount: 0,
      errorCode: "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE",
    };
  }

  const approved = unapplied.filter(
    (proposal) => proposal.status === "approved",
  );
  const rejected = unapplied.filter(
    (proposal) => proposal.status === "rejected",
  );
  const hasIncompleteDuplicateDecision =
    approved.some(
      (proposal) =>
        proposal.match.status === "probable-duplicate" &&
        proposal.probableDuplicateChoice !== "create-as-new",
    ) ||
    rejected.some(
      (proposal) =>
        proposal.match.status === "probable-duplicate" &&
        proposal.probableDuplicateChoice !== "skip-as-same",
    );
  if (hasIncompleteDuplicateDecision) {
    return {
      ready: false,
      approvedCount: approved.length,
      errorCode: "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE",
    };
  }
  const hasInvalidApproved = approved.some(
    (proposal) => proposal.payload === null || proposal.revisionId === null,
  );
  if (hasInvalidApproved) {
    return {
      ready: false,
      approvedCount: approved.length,
      errorCode: "NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH",
    };
  }

  return {
    ready: true,
    approvedCount: approved.length,
    errorCode: null,
  };
}

export type ChronicleApplyFailureReason =
  | "lineage-invalid"
  | "disclosure-scope-stale"
  | "source-stale"
  | "unknown";

/** Classifies a Native apply failure by its error message. */
export function classifyChronicleApplyFailure(
  error: unknown,
): ChronicleApplyFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("NEX_V2_APPLY_LINEAGE_INVALID")) {
    return "lineage-invalid";
  }
  if (
    message.includes("NEX_SOURCE_BASIS_STALE") &&
    message.includes("scope-dependency:v1:")
  ) {
    return "disclosure-scope-stale";
  }
  if (
    message.includes("NEX_SOURCE_BASIS_STALE") ||
    message.includes("NEX_READ_SET_STALE") ||
    message.includes("NEX_SCENE_VERSION_MISMATCH")
  ) {
    return "source-stale";
  }
  return "unknown";
}

export function selectChronicleProposalsForAtomicApply(
  proposals: readonly ChronicleReviewProposal[],
): readonly ChronicleReviewProposal[] {
  const readiness = getChronicleApplyReadiness(proposals);
  if (!readiness.ready) {
    throw new Error(
      `${readiness.errorCode}: Chronicle review is not a complete atomic apply set`,
    );
  }
  return proposals.filter(
    (proposal) =>
      proposal.applicability === "applicable" &&
      proposal.application === null &&
      proposal.status === "approved",
  );
}

export interface ChronicleExtractionReviewProjection {
  readonly runId: string;
  readonly projectId: string;
  readonly workspacePath: string | null;
  readonly openRevision: number | null;
  /** Native proposal set used by prepare/apply commit. */
  readonly proposalSetId: string | null;
  readonly status: NarrativeExtractionRunStatus;
  readonly coverage: ChronicleExtractionCoverage;
  readonly taskCounts: NarrativeExtractionTaskCounts;
  /** Exact immutable Event catalog sealed by this Run, for revision rematch. */
  readonly existingEventsCatalog?:
    | readonly ExistingChronicleEventCatalogRecord[]
    | null;
  readonly proposals: readonly ChronicleReviewProposal[];
}

export interface ChronicleExtractionRecoveryScope {
  readonly projectId: string;
  readonly workspacePath: string;
  readonly openRevision: number;
}

export interface ChronicleExtractionRecoveryState {
  readonly status: "idle" | "discovering" | "ready" | "resuming" | "blocked";
  readonly scope: ChronicleExtractionRecoveryScope | null;
  readonly candidates: readonly ChronicleTaskResumeCandidate[];
  readonly resumingRunId: string | null;
  readonly errorCode: string | null;
}

const EMPTY_RECOVERY_STATE: ChronicleExtractionRecoveryState = {
  status: "idle",
  scope: null,
  candidates: [],
  resumingRunId: null,
  errorCode: null,
};

export function buildProposalSafetyFlags(args: {
  readonly match: ChronicleExistingMatch;
  readonly actuality: string | null | undefined;
  readonly evidenceMethods: readonly ChronicleReviewEvidenceQuote["method"][];
  readonly lossless?: boolean;
  readonly noDeps?: boolean;
  readonly fresh?: boolean;
}): ChronicleProposalSafetyFlags {
  const evidenceExact =
    args.evidenceMethods.length > 0 &&
    args.evidenceMethods.every(
      (method) => method === "exact" || method === "exact-with-context",
    );
  const actualitySettled =
    args.actuality === "actual" ||
    args.actuality === "attempted" ||
    args.actuality === "prevented";
  const noDuplicate = args.match.status === "none";
  const lossless = args.lossless ?? true;
  const noDeps = args.noDeps ?? true;
  const fresh = args.fresh ?? true;
  const riskLow = evidenceExact && actualitySettled && noDuplicate && lossless;
  return {
    fresh,
    evidenceExact,
    actualitySettled,
    noDuplicate,
    lossless,
    noDeps,
    riskLow,
  };
}

const EMPTY_TASK_COUNTS: NarrativeExtractionTaskCounts = {
  queued: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
};

interface ChronicleExtractionState {
  /** Active review projection for the current dialog scope (DB mirror). */
  projection: ChronicleExtractionReviewProjection | null;
  /** Durable Task recovery is independent from an older review projection. */
  recovery: ChronicleExtractionRecoveryState;
  selectedProposalId: string | null;
  /** Decision/revision writes in flight; Apply must not race these writes. */
  reviewMutationCount: number;
  /** Atomic Apply owns the review boundary until its Native journey settles. */
  applyMutationInFlight: boolean;
  setProjection: (projection: ChronicleExtractionReviewProjection) => void;
  clearProjection: () => void;
  /**
   * Drop projection when dialog scope no longer owns the run
   * (other workspace / project must not see foreign runs).
   */
  clearIfScopeMismatch: (scope: {
    projectId: string;
    workspacePath: string;
    openRevision: number;
  }) => void;
  beginRecoveryDiscovery: (scope: ChronicleExtractionRecoveryScope) => void;
  setRecoveryCandidates: (
    scope: ChronicleExtractionRecoveryScope,
    candidates: readonly ChronicleTaskResumeCandidate[],
  ) => void;
  blockRecovery: (
    scope: ChronicleExtractionRecoveryScope,
    errorCode: string,
  ) => void;
  beginCandidateResume: (runId: string) => void;
  completeCandidateResume: (runId: string) => void;
  clearRecovery: () => void;
  selectProposal: (proposalId: string | null) => void;
  tryBeginReviewMutation: () => boolean;
  endReviewMutation: () => void;
  tryBeginApplyMutation: () => boolean;
  endApplyMutation: () => void;
  updateProposalStatus: (
    proposalId: string,
    status: NarrativeProposalStatus,
  ) => void;
  setProbableDuplicateChoice: (
    proposalId: string,
    choice: ProbableDuplicateChoice,
  ) => void;
  /**
   * Apply a Native-persisted revision locally. `revisionId` must come from
   * `appendRevision` — never fabricate client-side IDs.
   */
  reviseProposalFields: (
    proposalId: string,
    revisionId: string,
    reconciliationEnvelopeDigest: string | null,
    match: ChronicleExistingMatch,
    patch: {
      title?: string;
      note?: string | null;
      secret?: boolean;
      revealDocumentRef?: string;
    },
  ) => void;
  /**
   * Merge Native's re-read judgements (and, after a bulk approval, the new
   * revision/status) into the projection the result was computed for. A result
   * for another run/project/workspace is dropped. Only `bulkApproval` (and the
   * synced fields) change: the author's selection and choices are untouched.
   */
  applyNativeReviewRows: (
    identity: ChronicleReviewProjectionIdentity,
    rows: readonly ChronicleNativeReviewRow[],
  ) => boolean;
  /** A failed re-read: judgements become unknown (null) for that projection. */
  clearBulkApprovalJudgements: (
    identity: ChronicleReviewProjectionIdentity,
  ) => void;
  /** Bulk approval succeeded but the re-read failed: mirror the response. */
  mirrorBulkApproved: (
    identity: ChronicleReviewProjectionIdentity,
    approved: readonly { proposalId: string; revisionId: string }[],
  ) => void;
}

function sameProjectionIdentity(
  projection: ChronicleExtractionReviewProjection | null,
  identity: ChronicleReviewProjectionIdentity,
): projection is ChronicleExtractionReviewProjection {
  return (
    projection !== null &&
    projection.runId === identity.runId &&
    projection.projectId === identity.projectId &&
    projection.workspacePath === identity.workspacePath &&
    projection.openRevision === identity.openRevision
  );
}

function replaceProposal(
  proposals: readonly ChronicleReviewProposal[],
  proposalId: string,
  next: ChronicleReviewProposal,
): ChronicleReviewProposal[] {
  return proposals.map((proposal) =>
    proposal.proposalId === proposalId ? next : proposal,
  );
}

export const useChronicleExtractionStore = create<ChronicleExtractionState>(
  (set, get) => ({
    projection: null,
    recovery: EMPTY_RECOVERY_STATE,
    selectedProposalId: null,
    reviewMutationCount: 0,
    applyMutationInFlight: false,

    setProjection: (projection) => {
      const selected =
        projection.proposals.find(
          (proposal) => proposal.proposalId === get().selectedProposalId,
        )?.proposalId ??
        projection.proposals[0]?.proposalId ??
        null;
      set({ projection, selectedProposalId: selected });
    },

    clearProjection: () => {
      set({ projection: null, selectedProposalId: null });
    },

    clearIfScopeMismatch: (scope) => {
      const projection = get().projection;
      const recoveryScope = get().recovery.scope;
      const projectionMismatch =
        projection !== null &&
        (projection.projectId !== scope.projectId ||
          projection.workspacePath !== scope.workspacePath ||
          projection.openRevision !== scope.openRevision);
      const recoveryMismatch =
        recoveryScope !== null &&
        (recoveryScope.projectId !== scope.projectId ||
          recoveryScope.workspacePath !== scope.workspacePath ||
          recoveryScope.openRevision !== scope.openRevision);
      if (projectionMismatch || recoveryMismatch) {
        set({
          ...(projectionMismatch
            ? { projection: null, selectedProposalId: null }
            : {}),
          ...(recoveryMismatch ? { recovery: EMPTY_RECOVERY_STATE } : {}),
        });
      }
    },

    beginRecoveryDiscovery: (scope) => {
      set({
        recovery: {
          status: "discovering",
          scope: { ...scope },
          candidates: [],
          resumingRunId: null,
          errorCode: null,
        },
      });
    },

    setRecoveryCandidates: (scope, candidates) => {
      set({
        recovery: {
          status: "ready",
          scope: { ...scope },
          candidates: [...candidates],
          resumingRunId: null,
          errorCode: null,
        },
      });
    },

    blockRecovery: (scope, errorCode) => {
      const current = get().recovery;
      const sameScope =
        current.scope?.projectId === scope.projectId &&
        current.scope.workspacePath === scope.workspacePath &&
        current.scope.openRevision === scope.openRevision;
      set({
        recovery: {
          status: "blocked",
          scope: { ...scope },
          candidates: sameScope ? current.candidates : [],
          resumingRunId: null,
          errorCode,
        },
      });
    },

    beginCandidateResume: (runId) => {
      const recovery = get().recovery;
      if (
        recovery.status !== "ready" ||
        !recovery.candidates.some((candidate) => candidate.runId === runId)
      ) {
        return;
      }
      set({
        recovery: {
          ...recovery,
          status: "resuming",
          resumingRunId: runId,
          errorCode: null,
        },
      });
    },

    completeCandidateResume: (runId) => {
      const recovery = get().recovery;
      const candidates = recovery.candidates.filter(
        (candidate) => candidate.runId !== runId,
      );
      set({
        recovery:
          candidates.length > 0
            ? {
                ...recovery,
                status: "ready",
                candidates,
                resumingRunId: null,
                errorCode: null,
              }
            : EMPTY_RECOVERY_STATE,
      });
    },

    clearRecovery: () => {
      set({ recovery: EMPTY_RECOVERY_STATE });
    },

    selectProposal: (proposalId) => {
      set({ selectedProposalId: proposalId });
    },

    tryBeginReviewMutation: () => {
      if (get().applyMutationInFlight) return false;
      set((state) => ({ reviewMutationCount: state.reviewMutationCount + 1 }));
      return true;
    },

    endReviewMutation: () => {
      set((state) => ({
        reviewMutationCount: Math.max(0, state.reviewMutationCount - 1),
      }));
    },

    tryBeginApplyMutation: () => {
      const state = get();
      if (state.applyMutationInFlight || state.reviewMutationCount > 0) {
        return false;
      }
      set({ applyMutationInFlight: true });
      return true;
    },

    endApplyMutation: () => {
      set({ applyMutationInFlight: false });
    },

    updateProposalStatus: (proposalId, status) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.proposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (
        !current ||
        current.applicability === "already-satisfied" ||
        current.application !== null
      ) {
        return;
      }
      set({
        projection: {
          ...projection,
          proposals: replaceProposal(projection.proposals, proposalId, {
            ...current,
            status,
            // Local change: the old judgement no longer describes it until the
            // caller re-reads Native's judgement.
            bulkApproval: null,
          }),
        },
      });
    },

    setProbableDuplicateChoice: (proposalId, choice) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.proposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (
        !current ||
        current.application !== null ||
        current.match.status !== "probable-duplicate"
      ) {
        return;
      }
      const status: NarrativeProposalStatus =
        choice === "hold"
          ? "held"
          : choice === "skip-as-same"
            ? "rejected"
            : "approved";
      set({
        projection: {
          ...projection,
          proposals: replaceProposal(projection.proposals, proposalId, {
            ...current,
            probableDuplicateChoice: choice,
            status,
            bulkApproval: null,
          }),
        },
      });
    },

    reviseProposalFields: (
      proposalId,
      revisionId,
      reconciliationEnvelopeDigest,
      match,
      patch,
    ) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.proposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (
        !current?.payload ||
        current.applicability === "already-satisfied" ||
        current.application !== null
      ) {
        return;
      }
      const nextPayload: CreateChronicleEventProposalPayloadV1 = {
        ...current.payload,
        title:
          patch.title !== undefined
            ? patch.title.trim()
            : current.payload.title,
        note:
          patch.note !== undefined
            ? patch.note === null
              ? null
              : patch.note.trim() || null
            : current.payload.note,
        disclosure: {
          secret:
            patch.secret !== undefined
              ? patch.secret
              : current.payload.disclosure.secret,
          revealDocumentRef:
            patch.revealDocumentRef ??
            current.payload.disclosure.revealDocumentRef,
        },
      };
      set({
        projection: {
          ...projection,
          proposals: replaceProposal(projection.proposals, proposalId, {
            ...current,
            payload: nextPayload,
            displayTitle: nextPayload.title,
            revisionId,
            reconciliationEnvelopeDigest,
            status: "unreviewed",
            // The API rematches title edits against the Run-sealed Event
            // catalog before publishing this revision. Never inherit a parent
            // revision's duplicate choice or plan-time freshness proof.
            probableDuplicateChoice: null,
            match,
            safety: {
              ...current.safety,
              fresh: false,
              noDuplicate: false,
              riskLow: false,
            },
            bulkApproval: null,
          }),
        },
      });
    },

    applyNativeReviewRows: (identity, rows) => {
      const projection = get().projection;
      if (!sameProjectionIdentity(projection, identity)) return false;
      const byId = new Map(rows.map((row) => [row.proposalId, row] as const));
      const proposals = projection.proposals.map((current) => {
        const row = byId.get(current.proposalId);
        if (!row) {
          // Not in Native's answer: nothing is known about it.
          return current.bulkApproval === null ||
            current.bulkApproval === undefined
            ? current
            : { ...current, bulkApproval: null };
        }
        const sync = row.sync;
        if (
          sync &&
          current.application === null &&
          current.applicability === "applicable"
        ) {
          return {
            ...current,
            revisionId: sync.revisionId,
            status: sync.status,
            payload: sync.payload,
            displayTitle: sync.payload.title,
            reconciliationEnvelopeDigest: sync.reconciliationEnvelopeDigest,
            reconciliationEnvelopeSchemaVersion:
              sync.reconciliationEnvelopeSchemaVersion,
            safety:
              sync.revisionId === current.revisionId
                ? current.safety
                : {
                    ...current.safety,
                    fresh: false,
                    noDuplicate: false,
                    riskLow: false,
                  },
            bulkApproval: row.bulkApproval,
          };
        }
        return { ...current, bulkApproval: row.bulkApproval };
      });
      set({ projection: { ...projection, proposals } });
      return true;
    },

    clearBulkApprovalJudgements: (identity) => {
      const projection = get().projection;
      if (!sameProjectionIdentity(projection, identity)) return;
      set({
        projection: {
          ...projection,
          proposals: projection.proposals.map((proposal) =>
            proposal.bulkApproval === null ||
            proposal.bulkApproval === undefined
              ? proposal
              : { ...proposal, bulkApproval: null },
          ),
        },
      });
    },

    mirrorBulkApproved: (identity, approved) => {
      const projection = get().projection;
      if (!sameProjectionIdentity(projection, identity)) return;
      const byId = new Map(
        approved.map((item) => [item.proposalId, item.revisionId] as const),
      );
      set({
        projection: {
          ...projection,
          proposals: projection.proposals.map((proposal) => {
            const revisionId = byId.get(proposal.proposalId);
            if (revisionId === undefined || !proposal.payload) {
              return proposal.bulkApproval === null ||
                proposal.bulkApproval === undefined
                ? proposal
                : { ...proposal, bulkApproval: null };
            }
            return {
              ...proposal,
              revisionId,
              status: "approved" as const,
              payload: {
                ...proposal.payload,
                disclosure: { ...proposal.payload.disclosure, secret: false },
              },
              // The child's sealed Envelope digest was not read back.
              reconciliationEnvelopeDigest: null,
              bulkApproval: null,
            };
          }),
        },
      });
    },
  }),
);

export function emptyTaskCounts(): NarrativeExtractionTaskCounts {
  return { ...EMPTY_TASK_COUNTS };
}

/** Test helper: wipe extraction review state. */
export function resetChronicleExtractionStoreForTests(): void {
  useChronicleExtractionStore.setState({
    projection: null,
    recovery: EMPTY_RECOVERY_STATE,
    selectedProposalId: null,
    reviewMutationCount: 0,
    applyMutationInFlight: false,
  });
}
