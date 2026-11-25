export type WorkLayerSystemState = "idle" | "running" | "blocked";

export type WorkLedgerStatus = "active" | "waiting" | "held" | "completed";

export interface WorkLedgerItemView {
  readonly id: string;
  readonly title: string;
  readonly status: WorkLedgerStatus;
  readonly detail?: string;
  readonly taskProgress?: {
    readonly completed: number;
    readonly total: number;
  };
  readonly tag?: string;
  readonly updatedLabel?: string;
}

export interface SystemActivityView {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly state: "queued" | "running" | "completed";
}

export interface BatchProposalView {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly eligible: boolean;
  readonly reason: string;
}

export interface AuthorTaskView {
  readonly id: string;
  readonly title: string;
  readonly completed: boolean;
}

export interface WorkLayerFocusTarget {
  readonly id: string;
  readonly title: string;
}

export interface WorkLayerFocusView extends WorkLayerFocusTarget {
  readonly authorTasks: readonly AuthorTaskView[];
  readonly later: readonly WorkLayerFocusTarget[];
}

export interface WorkLayerCandidateView {
  readonly id: string;
  readonly label: string;
  readonly meta: string;
}

export interface SystemWorkView {
  readonly runId: string;
  readonly taskLabel: string;
  readonly attemptLabel: string;
  readonly authority: string;
  readonly epoch: string;
}

export interface WorkLayerFindingView {
  readonly id: string;
  readonly groupLabel: string;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly source: {
    readonly label: string;
    readonly excerpt: string | null;
  };
  readonly reason: string;
  readonly previousValue: string;
  readonly candidates: readonly WorkLayerCandidateView[];
  readonly impact: readonly string[];
  readonly states: {
    readonly review: string;
    readonly freshness: string;
    readonly projection: string;
  };
  readonly materialChain: readonly string[];
  readonly systemWork: SystemWorkView;
}

export type WorkLayerDisposition =
  | "snoozed"
  | "held"
  | "basis-ignored"
  | "dismissed"
  | "legacy";

export type WorkLayerPreviewDisposition = Extract<
  WorkLayerDisposition,
  "held" | "basis-ignored"
>;

export interface DisposedAttentionView {
  readonly id: string;
  readonly title: string;
  readonly disposition: WorkLayerDisposition;
}

export interface WorkLayerAnchorPosition {
  readonly xPercent: number;
  readonly yPercent: number;
  readonly heightPx: number;
}

export interface WorkLayerModel {
  readonly scopeId: string;
  /** Live models only; they use attention: [] and omit attentionDelta. Preview omits this. */
  readonly liveEntries?: readonly WorkLayerLiveEntry[];
  /** One-shot visual hint supplied by a preview adapter; never a durable count. */
  readonly attentionDelta?: number;
  /** Preview-only hint: render an arrival gutter only while its anchor is visible. */
  readonly attentionAnchorVisible?: boolean;
  /** Viewport-relative preview coordinates supplied by the visible editor anchor. */
  readonly attentionAnchorPosition?: WorkLayerAnchorPosition;
  /** Whether the active layout already contains Codex; Portal is only for absence. */
  readonly codexPanelAvailable?: boolean;
  readonly focus: WorkLayerFocusView | null;
  /** Active author-facing Findings only. Disposed records stay separate. */
  readonly attention: readonly WorkLayerFindingView[];
  readonly disposedAttention: readonly DisposedAttentionView[];
  readonly allWork?: readonly WorkLedgerItemView[];
  readonly batchProposals?: readonly BatchProposalView[];
  readonly system: {
    readonly state: WorkLayerSystemState;
    readonly label: string;
    readonly activities?: readonly SystemActivityView[];
    readonly blockedReason?: string;
    readonly staleImpact?: string;
  };
}

export type WorkLayerLiveEntryId = "codex-candidates" | "stale-proposals";

export type WorkLayerLiveEntryStatus = "ready" | "not-counted" | "unavailable";

export type WorkLayerOpenSurface = {
  readonly surface: "structure-extract-review";
};

/** Why an entry could not be counted. Only meaningful with `unavailable`. */
export type WorkLayerLiveEntryReason = "failed" | "timed-out";

export interface WorkLayerLiveEntry {
  readonly id: WorkLayerLiveEntryId;
  readonly status: WorkLayerLiveEntryStatus;
  readonly count: number | null;
  readonly open?: WorkLayerOpenSurface;
  /** Display hint for `unavailable`: a read that failed vs. one still running past the wait limit. */
  readonly reason?: WorkLayerLiveEntryReason;
}

export type WorkLayerPortKind = "fixture" | "live";

export type WorkLayerLoadReason = "mount" | "tray-open";

export interface WorkLayerLoadRequest {
  readonly reason: WorkLayerLoadReason;
}

/** UI-only read boundary for fixture previews and read-only live data. */
export interface WorkLayerPort {
  readonly kind: WorkLayerPortKind;
  readonly scopeKey: string;
  load(request: WorkLayerLoadRequest): Promise<WorkLayerModel>;
  subscribe?(listener: (model: WorkLayerModel) => void): () => void;
  /** Open a screen outside the Work Layer. The host wires the surface name to the real screen. */
  openSurface?(surface: WorkLayerOpenSurface): void;
  dispose?(): void;
}

export type CandidateCountSnapshot =
  | { readonly status: "ready"; readonly count: number }
  | { readonly status: "not-counted" }
  | { readonly status: "unavailable" };

export interface WorkLayerLivePortDependencies {
  readonly projectId: string;
  readonly readStaleProposalCount: () => Promise<
    | { readonly allowed: false }
    | { readonly allowed: true; readonly count: number }
  >;
  readonly readCandidateCount: () => CandidateCountSnapshot;
  readonly ensureCandidateScan: () => Promise<void>;
  readonly subscribeCandidateCount: (listener: () => void) => () => void;
  readonly isCandidateExtractionApplicable: () => boolean;
  readonly structureReviewAvailable: () => boolean;
  /** Opens the structure-extraction review screen (the `structure-extract-review` surface). */
  readonly openStructureReview?: () => void;
  readonly displayWaitLimitMs?: number;
}
