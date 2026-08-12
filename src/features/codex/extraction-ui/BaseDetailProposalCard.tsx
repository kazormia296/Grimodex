import type { CodexBaseDetailReviewProposal } from "../codexStructureExtractionStore";
import { isSafeForCodexBaseDetailBulkApprove } from "../codexStructureExtractionStore";
import type { NarrativeProposalStatus } from "@/features/narrative-extraction/runtime/types";
import type { ProjectedDetailValue } from "@/features/codex/details/semanticBindingTypes";

export interface BaseDetailProposalCardProps {
  readonly proposal: CodexBaseDetailReviewProposal;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
  readonly onDecide?: (
    status: Exclude<NarrativeProposalStatus, "unreviewed">,
  ) => void;
}

function statusGlyph(proposal: CodexBaseDetailReviewProposal): string {
  if (proposal.applicability === "blocked" || proposal.unbound) return "⊘";
  if (proposal.status === "approved") return "☑";
  if (proposal.status === "rejected") return "☒";
  if (proposal.status === "deferred" || proposal.status === "held") return "…";
  return "□";
}

export function formatProjectedDetailValue(
  value: ProjectedDetailValue | null | undefined,
): string {
  if (!value) return "(empty)";
  if (value.kind === "text") return value.text || "(empty text)";
  if (value.kind === "enum") return value.optionRef;
  if (value.kind === "entity") return value.entityId;
  return "(clear)";
}

/**
 * Base Detail set proposal card.
 */
export function BaseDetailProposalCard({
  proposal,
  selected = false,
  onSelect,
  onDecide,
}: BaseDetailProposalCardProps) {
  const blocked = proposal.applicability === "blocked" || Boolean(proposal.unbound);
  const safeHint =
    !blocked &&
    proposal.status === "unreviewed" &&
    isSafeForCodexBaseDetailBulkApprove(proposal.safety);
  const next = formatProjectedDetailValue(proposal.proposal.payload.value);
  const previous = formatProjectedDetailValue(proposal.existingValue);

  return (
    <div
      className={`flex flex-col gap-1.5 border-b border-border px-2 py-2 last:border-b-0 ${
        selected ? "bg-accent/50" : "hover:bg-accent/30"
      }`}
      data-testid={`base-detail-proposal-card-${proposal.proposalId}`}
      data-selected={selected ? "true" : "false"}
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
            Base · {proposal.facetKey} ·{" "}
            {proposal.proposal.payload.temporalEligibility}
          </span>
          <span className="block text-[10px] text-foreground">
            {previous} → {next}
          </span>
          {blocked && (
            <span className="block text-[10px] text-amber-700 dark:text-amber-400">
              {proposal.blockedReason ??
                (proposal.unbound ? "Detail 未割当" : "要解決")}
            </span>
          )}
          {safeHint && (
            <span className="block text-[10px] text-emerald-700 dark:text-emerald-400">
              安全一括承認の対象
            </span>
          )}
        </span>
      </button>

      {!blocked && (
        <div className="flex flex-wrap gap-1 pl-6">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10 disabled:opacity-40"
            disabled={proposal.status === "approved"}
            onClick={() => onDecide?.("approved")}
            data-testid={`base-detail-approve-${proposal.proposalId}`}
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
