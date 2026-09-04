import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import type { BatchProposalView } from "./types";

interface BatchProposalListProps {
  readonly proposals: readonly BatchProposalView[];
  readonly selectedIds: readonly string[];
  readonly onToggle: (proposalId: string) => void;
}

export function BatchProposalList({
  proposals,
  selectedIds,
  onToggle,
}: BatchProposalListProps) {
  const { t } = useTranslation();

  return (
    <div className="mt-4 space-y-2">
      {proposals.map((proposal) => {
        const pressed = selectedIds.includes(proposal.id);
        return (
          <button
            id={"work-layer-batch-proposal-" + proposal.id}
            key={proposal.id}
            type="button"
            aria-pressed={pressed}
            disabled={!proposal.eligible}
            onClick={() => onToggle(proposal.id)}
            className={cn(
              "flex w-full items-start gap-3 rounded-sm border border-foreground/30 px-4 py-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:border-dashed disabled:text-muted-foreground disabled:hover:bg-transparent",
              pressed && "bg-accent",
            )}
          >
            <span className="mt-0.5 font-mono text-[8px] tracking-[0.12em]">
              {proposal.eligible
                ? pressed
                  ? "SELECTED"
                  : "READY"
                : "INDIVIDUAL"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium">
                {proposal.title}
              </span>
              <span className="mt-1 block text-[10px] text-muted-foreground">
                {proposal.eligible
                  ? "SAFE"
                  : t("workLayer.batch.individual", "要個別判断")}{" "}
                · {proposal.detail} · {proposal.reason}
              </span>
            </span>
          </button>
        );
      })}
      {proposals.length === 0 && (
        <p className="rounded-sm border border-border p-4 text-xs text-muted-foreground">
          {t("workLayer.batch.empty", "一括確認できるProposalはありません。")}
        </p>
      )}
    </div>
  );
}
