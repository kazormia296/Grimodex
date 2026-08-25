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
  readonly match: ChronicleExistingMatch;
  readonly evidence: readonly ChronicleReviewEvidenceQuote[];
  readonly safety: ChronicleProposalSafetyFlags;
  readonly probableDuplicateChoice: ProbableDuplicateChoice | null;
  readonly blockedReason?: string;
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
  readonly proposals: readonly ChronicleReviewProposal[];
}

export function isSafeForBulkApprove(
  flags: ChronicleProposalSafetyFlags,
): boolean {
  return (
    flags.fresh &&
    flags.evidenceExact &&
    flags.actualitySettled &&
    flags.noDuplicate &&
    flags.lossless &&
    flags.noDeps &&
    flags.riskLow
  );
}

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
  selectedProposalId: string | null;
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
  selectProposal: (proposalId: string | null) => void;
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
    patch: {
      title?: string;
      note?: string | null;
      secret?: boolean;
      revealDocumentRef?: string;
    },
  ) => void;
  bulkApproveSafe: () => number;
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
    selectedProposalId: null,

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
      if (!projection) return;
      const mismatch =
        projection.projectId !== scope.projectId ||
        projection.workspacePath !== scope.workspacePath ||
        projection.openRevision !== scope.openRevision;
      if (mismatch) {
        set({ projection: null, selectedProposalId: null });
      }
    },

    selectProposal: (proposalId) => {
      set({ selectedProposalId: proposalId });
    },

    updateProposalStatus: (proposalId, status) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.proposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (!current || current.applicability === "already-satisfied") return;
      set({
        projection: {
          ...projection,
          proposals: replaceProposal(projection.proposals, proposalId, {
            ...current,
            status,
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
      if (!current || current.match.status !== "probable-duplicate") return;
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
          }),
        },
      });
    },

    reviseProposalFields: (
      proposalId,
      revisionId,
      reconciliationEnvelopeDigest,
      patch,
    ) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.proposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (!current?.payload || current.applicability === "already-satisfied") {
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
          }),
        },
      });
    },

    bulkApproveSafe: () => {
      const projection = get().projection;
      if (!projection) return 0;
      let approved = 0;
      const proposals = projection.proposals.map((proposal) => {
        if (
          proposal.applicability !== "applicable" ||
          proposal.status !== "unreviewed" ||
          !isSafeForBulkApprove(proposal.safety)
        ) {
          return proposal;
        }
        approved += 1;
        return { ...proposal, status: "approved" as const };
      });
      set({ projection: { ...projection, proposals } });
      return approved;
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
    selectedProposalId: null,
  });
}
