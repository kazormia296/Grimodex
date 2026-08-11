import type { DocumentRef, NarrativeEventId } from "../temporal/nodes";

export type NarrativeExtractionRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type NarrativeExtractionTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type NarrativeExtractionAttemptStatus =
  | "running"
  | "completed"
  | "failed";

export type NarrativeArtifactPayloadStorage = "inline-json" | "ref";

export type NarrativeProposalStatus =
  | "unreviewed"
  | "approved"
  | "rejected"
  | "deferred"
  | "held";

export type NarrativeProposalDecision =
  | "approved"
  | "rejected"
  | "deferred"
  | "held";

export interface NarrativeExtractionRun {
  readonly runId: string;
  readonly projectId: string;
  readonly surfacePathId: string;
  readonly scopeJson: Readonly<Record<string, unknown>>;
  readonly specJson: Readonly<Record<string, unknown>>;
  readonly specDigest: string;
  readonly snapshotDigest: string | null;
  readonly catalogDigest: string | null;
  readonly registryDigest: string | null;
  readonly status: NarrativeExtractionRunStatus;
  readonly coverageJson: Readonly<Record<string, unknown>>;
  readonly outcomeSummaryJson: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly version: number;
}

export interface NarrativeExtractionTask {
  readonly taskId: string;
  readonly runId: string;
  readonly taskKind: string;
  readonly status: NarrativeExtractionTaskStatus;
  readonly inputJson: Readonly<Record<string, unknown>>;
  readonly outputJson: Readonly<Record<string, unknown>> | null;
  readonly priority: number;
  readonly attemptCount: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly heartbeatAt: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly version: number;
}

export interface NarrativeExtractionAttempt {
  readonly attemptId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly status: NarrativeExtractionAttemptStatus;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly errorMessage: string | null;
  readonly outputJson: Readonly<Record<string, unknown>> | null;
}

export interface NarrativeExtractionArtifact {
  readonly artifactId: string;
  readonly runId: string;
  readonly taskId: string | null;
  readonly attemptId: string | null;
  readonly artifactKind: string;
  readonly payloadStorage: NarrativeArtifactPayloadStorage;
  readonly payloadJson: Readonly<Record<string, unknown>> | null;
  readonly payloadRef: string | null;
  readonly payloadDigest: string | null;
  readonly createdAt: string;
}

export interface NarrativeExtractionTaskCounts {
  readonly queued: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface NarrativeExtractionRunProjection {
  readonly run: NarrativeExtractionRun;
  readonly tasks: readonly NarrativeExtractionTask[];
  readonly taskCounts: NarrativeExtractionTaskCounts;
}

export interface NarrativeProposalRevision {
  readonly revisionId: string;
  readonly proposalId: string;
  readonly revisionNumber: number;
  readonly payloadJson: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface NarrativeProposalDecisionRecord {
  readonly decisionId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly decision: NarrativeProposalDecision;
  readonly decisionJson: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface NarrativeProposal {
  readonly proposalId: string;
  readonly proposalSetId: string;
  readonly proposalKey: string;
  readonly kind: string;
  readonly status: NarrativeProposalStatus;
  readonly payloadJson: Readonly<Record<string, unknown>>;
  readonly currentRevisionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NarrativeProposalSet {
  readonly proposalSetId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly setKind: string;
  readonly status: "draft" | "published" | "superseded";
  readonly summaryJson: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly proposals: readonly NarrativeProposal[];
}

export interface CreateChronicleEventProposalRecord {
  readonly proposalId: string;
  readonly proposalKey: string;
  readonly revisionId: string;
  readonly status: NarrativeProposalStatus;
  readonly eventId: NarrativeEventId;
  readonly documentRefs: readonly DocumentRef[];
}
