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

/**
 * UI-only read boundary. The production NIR adapter intentionally does not
 * exist in this slice; Storybook and explicitly-enabled development previews
 * provide fixtures through this port.
 */
export interface WorkLayerPort {
  load(): Promise<WorkLayerModel>;
}
