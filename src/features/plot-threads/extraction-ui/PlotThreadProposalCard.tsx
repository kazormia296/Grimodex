import { useTranslation } from "react-i18next";
import type { PlotPhaseType } from "@/db/schema";
import type { PlannedPlotThreadProposal } from "@/features/plot-threads/extraction/proposalPlanner";

export interface PlotThreadProposalCardProps {
  readonly proposal: PlannedPlotThreadProposal;
  /** Resolves a human-readable label for a documentRef (falls back to the ref itself). */
  readonly documentLabel?: (documentRef: string) => string;
  readonly phaseLabel?: (phase: PlotPhaseType) => string;
}

function bindingLabel(
  binding: PlannedPlotThreadProposal["threadProposal"]["payload"]["binding"],
  t: (key: string, fallback: string) => string,
): string {
  switch (binding.kind) {
    case "create-new":
      return t("plotThread.reviewExtract.binding.createNew", "新規作成");
    case "bind-existing":
      return t(
        "plotThread.reviewExtract.binding.bindExisting",
        "既存スレッドへ統合",
      );
    case "unresolved":
      return t(
        "plotThread.reviewExtract.binding.unresolved",
        "候補が複数あり未解決",
      );
  }
}

/**
 * Presentational review card for one planned Plot Thread proposal
 * (BindPlotThreadProposal + its PlacePlotThreadMarkerProposal rows).
 * Read-only preview — no store wiring; the extraction pipeline that
 * produces PlannedPlotThreadProposal[] is not yet connected to a commit UI.
 */
export function PlotThreadProposalCard({
  proposal,
  documentLabel,
  phaseLabel,
}: PlotThreadProposalCardProps) {
  const { t } = useTranslation();
  const payload = proposal.threadProposal.payload;

  return (
    <li
      data-testid={`plot-thread-proposal-card-${proposal.hypothesisId}`}
      className="flex flex-col gap-1.5 px-3 py-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">{payload.name}</span>
        <span className="shrink-0 rounded bg-accent/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {bindingLabel(payload.binding, t)}
        </span>
      </div>

      {payload.description.kind !== "leave" && payload.description.value && (
        <p className="text-xs text-muted-foreground">
          {payload.description.value}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5">
          {t(
            `plotThread.reviewExtract.prominence.${payload.prominence}`,
            payload.prominence,
          )}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5">
          {payload.core.kind}
        </span>
        <span>
          {t("plotThread.reviewExtract.markerCount", "マーカー {{n}} 件", {
            n: proposal.markerProposals.length,
          })}
        </span>
      </div>

      {proposal.blocked && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {proposal.blockedReason ??
            t("plotThread.reviewExtract.blocked", "要確認")}
        </p>
      )}

      {proposal.markerProposals.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {proposal.markerProposals.map((marker) => (
            <li
              key={marker.proposalId}
              className="inline-flex items-center gap-1 rounded bg-accent/40 px-1.5 py-0.5 text-[10px] text-foreground"
              title={
                documentLabel?.(marker.payload.documentRef) ??
                marker.payload.documentRef
              }
            >
              <span className="max-w-[120px] truncate">
                {documentLabel?.(marker.payload.documentRef) ??
                  marker.payload.documentRef}
              </span>
              <span className="text-muted-foreground">
                {phaseLabel?.(marker.payload.phaseType) ??
                  marker.payload.phaseType}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
