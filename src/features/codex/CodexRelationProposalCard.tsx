import type { CodexRelationReviewProposal } from "./codexStructureExtractionStore";
import type { NarrativeProposalStatus } from "@/features/narrative-extraction/runtime/types";

export interface CodexRelationProposalCardProps {
  readonly proposal: CodexRelationReviewProposal;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
  readonly onDecide?: (
    status: Exclude<NarrativeProposalStatus, "unreviewed">,
  ) => void;
}

function statusGlyph(proposal: CodexRelationReviewProposal): string {
  if (proposal.applicability === "already-satisfied") return "✓";
  if (proposal.applicability === "blocked") return "⊘";
  if (proposal.status === "approved") return "☑";
  if (proposal.status === "rejected") return "☒";
  if (proposal.status === "deferred" || proposal.status === "held") return "…";
  return "□";
}

/**
 * Compact list-row card for Codex Relation create proposals.
 * Bulk approve is intentionally unsupported (spec §22).
 */
export function CodexRelationProposalCard({
  proposal,
  selected = false,
  onSelect,
  onDecide,
}: CodexRelationProposalCardProps) {
  const blocked = proposal.applicability === "blocked";
  const alreadySatisfied = proposal.applicability === "already-satisfied";
  const applied = Boolean(proposal.application);
  const relation = proposal.proposal.payload.relation;

  return (
    <div
      className={`flex flex-col gap-1.5 border-b border-border px-2 py-2 last:border-b-0 ${
        selected ? "bg-accent/50" : "hover:bg-accent/30"
      }`}
      data-testid={`codex-relation-proposal-card-${proposal.proposalId}`}
      data-selected={selected ? "true" : "false"}
      data-applicability={proposal.applicability}
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
        onClick={onSelect}
      >
        <span className="mt-0.5 w-4 shrink-0 text-xs" aria-hidden>
          {statusGlyph(proposal)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {proposal.displayTitle}
          </span>
          <span className="block text-[10px] text-muted-foreground">
            {proposal.subjectLabel} · {relation.forwardLabel} ·{" "}
            {proposal.objectLabel} · {relation.directionality}
          </span>
          {(blocked || alreadySatisfied) && (
            <span className="block text-[10px] text-amber-700 dark:text-amber-400">
              {proposal.blockedReason ??
                (alreadySatisfied
                  ? "既に同じ関係が登録されています（適用不要）"
                  : "両端 Binding 未解決")}
            </span>
          )}
          {applied && (
            <span className="block text-[10px] text-muted-foreground">
              適用済み（編集不可）
            </span>
          )}
        </span>
      </button>

      {!blocked && !alreadySatisfied && !applied && (
        <div className="flex flex-wrap gap-1 pl-6">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10 disabled:opacity-40"
            disabled={proposal.status === "approved"}
            onClick={() => onDecide?.("approved")}
            data-testid={`codex-relation-approve-${proposal.proposalId}`}
          >
            承認
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
            disabled={proposal.status === "rejected"}
            onClick={() => onDecide?.("rejected")}
          >
            拒否
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
            disabled={
              proposal.status === "deferred" || proposal.status === "held"
            }
            onClick={() => onDecide?.("deferred")}
          >
            保留
          </button>
        </div>
      )}
    </div>
  );
}
