import type { CodexEntityRelationReviewDecision } from "./CodexEntityRelationRevisionReviewPanel";

export interface CodexEntityRelationRevisionReviewDecisionControlsProps {
  readonly canDecide: boolean;
  readonly canCancel: boolean;
  readonly busy: boolean;
  readonly onDecision: (decision: CodexEntityRelationReviewDecision) => void;
}

/** Explicit human controls for a typed Revision, including cancellation. */
export function CodexEntityRelationRevisionReviewDecisionControls({
  canDecide,
  canCancel,
  busy,
  onDecision,
}: CodexEntityRelationRevisionReviewDecisionControlsProps) {
  if (!canDecide && !canCancel) return null;
  return (
    <div className="mt-auto flex flex-wrap gap-2 border-t border-border/60 pt-2">
      {canDecide ? (
        <>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
            onClick={() => onDecision("approved")}
            disabled={busy}
            data-testid="nir1-typed-approve"
          >
            承認
          </button>
          <button
            type="button"
            className="rounded border border-input px-3 py-1.5 text-xs disabled:opacity-50"
            onClick={() => onDecision("rejected")}
            disabled={busy}
            data-testid="nir1-typed-reject"
          >
            却下
          </button>
          <button
            type="button"
            className="rounded border border-input px-3 py-1.5 text-xs disabled:opacity-50"
            onClick={() => onDecision("deferred")}
            disabled={busy}
            data-testid="nir1-typed-defer"
          >
            保留
          </button>
        </>
      ) : (
        <button
          type="button"
          className="rounded border border-destructive/60 px-3 py-1.5 text-xs text-destructive disabled:opacity-50"
          onClick={() => onDecision("rejected")}
          disabled={busy}
          data-testid="nir1-typed-cancel"
        >
          承認を取り消す
        </button>
      )}
    </div>
  );
}
