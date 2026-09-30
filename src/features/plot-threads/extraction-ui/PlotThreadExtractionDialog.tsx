import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { PlotPhaseType } from "@/db/schema";
import type { PlannedPlotThreadProposal } from "@/features/plot-threads/extraction/proposalPlanner";
import { PlotThreadProposalReview } from "./PlotThreadProposalReview";

export interface PlotThreadExtractionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Planned proposals to review. Presentational only: the caller is
   * responsible for producing these via signalIndex → seedManifest →
   * narrative_plot_thread_synthesize → proposalPlanner, and for committing
   * accepted proposals once that pipeline is wired end-to-end.
   */
  readonly proposals?: readonly PlannedPlotThreadProposal[];
  readonly documentLabel?: (documentRef: string) => string;
  readonly phaseLabel?: (phase: PlotPhaseType) => string;
}

/**
 * Review dialog for AI-synthesized Plot Thread proposals (new extraction
 * pipeline). This is a presentational shell: it takes already-planned
 * proposals as props and has no store/commit wiring yet.
 */
export function PlotThreadExtractionDialog({
  open,
  onOpenChange,
  proposals = [],
  documentLabel,
  phaseLabel,
}: PlotThreadExtractionDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t(
              "plotThread.reviewExtract.title",
              "プロットスレッド候補レビュー",
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <p className="text-xs text-muted-foreground">
            {t(
              "plotThread.reviewExtract.hint",
              "AI が提案したプロットスレッド候補をレビューします（プレビュー機能）。",
            )}
          </p>

          <PlotThreadProposalReview
            proposals={proposals}
            documentLabel={documentLabel}
            phaseLabel={phaseLabel}
          />
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            {t("common.close", "閉じる")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
