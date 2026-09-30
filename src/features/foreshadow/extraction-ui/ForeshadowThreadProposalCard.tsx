import { useTranslation } from "react-i18next";
import type { PlannedForeshadowProposal } from "@/features/foreshadow/extraction/proposalPlanner";

export interface ForeshadowThreadProposalCardProps {
  readonly proposal: PlannedForeshadowProposal;
  readonly documentLabel?: (documentRef: string) => string;
}

function bindingLabel(
  binding: PlannedForeshadowProposal["threadProposal"]["payload"]["binding"],
  t: (key: string, fallback: string) => string,
): string {
  switch (binding.kind) {
    case "create-new":
      return t("foreshadow.reviewExtract.binding.createNew", "新規作成");
    case "bind-existing":
      return t(
        "foreshadow.reviewExtract.binding.bindExisting",
        "既存伏線へ統合",
      );
    case "unresolved":
      return t(
        "foreshadow.reviewExtract.binding.unresolved",
        "候補が複数あり未解決",
      );
    case "already-satisfied":
      return t("foreshadow.reviewExtract.binding.alreadySatisfied", "既に充足");
  }
}

export function ForeshadowThreadProposalCard({
  proposal,
  documentLabel,
}: ForeshadowThreadProposalCardProps) {
  const { t } = useTranslation();
  const payload = proposal.threadProposal.payload;

  return (
    <li
      data-testid={`foreshadow-proposal-card-${proposal.hypothesisId}`}
      className="flex flex-col gap-1.5 px-3 py-2.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">{payload.title}</span>
        <span className="shrink-0 rounded bg-accent/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {bindingLabel(payload.binding, t)}
        </span>
      </div>

      {payload.intent.kind !== "leave" && payload.intent.value && (
        <p className="text-xs text-muted-foreground">{payload.intent.value}</p>
      )}

      <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5">
          {payload.core.bridgeKind}
        </span>
        <span>
          {t("foreshadow.reviewExtract.setupCount", "Setup {{n}}", {
            n: proposal.setupProposals.length,
          })}
        </span>
        <span>
          {t("foreshadow.reviewExtract.payoffCount", "Payoff {{n}}", {
            n: proposal.payoffProposals.length,
          })}
        </span>
        {proposal.qualityReport.payload.qualityIssue !== "none" && (
          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
            {proposal.qualityReport.payload.qualityIssue}
          </span>
        )}
      </div>

      {proposal.blocked && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {proposal.blockedReason ??
            t("foreshadow.reviewExtract.blocked", "要確認")}
        </p>
      )}

      {(proposal.setupProposals.length > 0 ||
        proposal.payoffProposals.length > 0) && (
        <ul className="flex flex-wrap gap-1">
          {proposal.setupProposals.map((setup) => (
            <li
              key={setup.proposalId}
              className="inline-flex items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-800 dark:text-blue-200"
              title={
                documentLabel?.(setup.payload.documentRef) ??
                setup.payload.documentRef
              }
            >
              <span className="max-w-[100px] truncate">
                {documentLabel?.(setup.payload.documentRef) ??
                  setup.payload.documentRef}
              </span>
              <span>setup</span>
            </li>
          ))}
          {proposal.payoffProposals.map((payoff) => (
            <li
              key={payoff.proposalId}
              className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-800 dark:text-emerald-200"
              title={
                documentLabel?.(payoff.payload.documentRef) ??
                payoff.payload.documentRef
              }
            >
              <span className="max-w-[100px] truncate">
                {documentLabel?.(payoff.payload.documentRef) ??
                  payoff.payload.documentRef}
              </span>
              <span>payoff</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
