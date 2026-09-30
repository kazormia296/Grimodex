interface CodexEntityRelationReviewDialogFooterProps {
  readonly typedReview: boolean;
  readonly typedPrepareBusy: boolean;
  readonly typedDecisionBusy: boolean;
  readonly sceneSelected: boolean;
  readonly onClose: () => void;
  readonly onPrepare: () => void;
}
export function CodexEntityRelationReviewDialogFooter({
  typedReview,
  typedPrepareBusy,
  typedDecisionBusy,
  sceneSelected,
  onClose,
  onPrepare,
}: CodexEntityRelationReviewDialogFooterProps) {
  return (
    <div className="flex flex-row items-center justify-end gap-2">
      <button
        type="button"
        className="rounded border border-input px-3 py-1.5 text-sm"
        onClick={onClose}
        disabled={typedPrepareBusy || typedDecisionBusy}
      >
        閉じる
      </button>
      {!typedReview && (
        <button
          type="button"
          className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          onClick={onPrepare}
          disabled={typedPrepareBusy || typedDecisionBusy || !sceneSelected}
          data-testid="nir1-typed-prepare"
        >
          {typedPrepareBusy ? "準備中…" : "Typedレビューを準備"}
        </button>
      )}
    </div>
  );
}
