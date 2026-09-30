import { useTranslation } from "react-i18next";

interface BatchReviewFooterProps {
  readonly selectedCount: number;
  readonly onIndividualReview: () => void;
  readonly onPreview: () => void;
}

export function BatchReviewFooter({
  selectedCount,
  onIndividualReview,
  onPreview,
}: BatchReviewFooterProps) {
  const { t } = useTranslation();

  return (
    <footer className="flex items-center gap-2 rounded-b-sm border border-foreground/30 p-3">
      <span className="font-mono text-[8px] tracking-[0.12em] text-muted-foreground">
        {selectedCount} SELECTED · PREVIEW ONLY
      </span>
      <button
        id="work-layer-batch-individual"
        type="button"
        onClick={onIndividualReview}
        className="ml-auto rounded-sm border border-foreground/30 px-3 py-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("workLayer.batch.viewIndividual", "個別に見る")}
      </button>
      <button
        type="button"
        disabled={selectedCount === 0}
        onClick={onPreview}
        className="rounded-sm bg-foreground px-3 py-2 text-xs font-medium text-background disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("workLayer.batch.preview", "一括承認をプレビュー")}
      </button>
    </footer>
  );
}
