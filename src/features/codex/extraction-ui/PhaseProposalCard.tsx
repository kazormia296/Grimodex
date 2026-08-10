import type { CodexPhaseReviewProposal } from "../codexStructureExtractionStore";
import { isSafeForCodexPhaseBulkApprove } from "../codexStructureExtractionStore";
import type { NarrativeProposalStatus } from "@/features/narrative-extraction/runtime/types";
import { PersistenceEvidence } from "./PersistenceEvidence";

export interface PhaseProposalCardProps {
  readonly proposal: CodexPhaseReviewProposal;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
  readonly onDecide?: (
    status: Exclude<NarrativeProposalStatus, "unreviewed">,
  ) => void;
}

function statusGlyph(proposal: CodexPhaseReviewProposal): string {
  if (proposal.applicability === "blocked") return "⊘";
  if (proposal.status === "approved") return "☑";
  if (proposal.status === "rejected") return "☒";
  if (proposal.status === "deferred" || proposal.status === "held") return "…";
  return "□";
}

function bindingLabel(proposal: CodexPhaseReviewProposal): string {
  const binding = proposal.proposal.payload.binding;
  if (binding.kind === "create-new") return `新規 · ${binding.phase.label}`;
  if (binding.kind === "bind-existing") return `既存追記 · ${binding.phaseRef}`;
  return "未解決";
}

/**
 * Phase bind proposal card: label, anchor, previous→new values, candidates.
 */
export function PhaseProposalCard({
  proposal,
  selected = false,
  onSelect,
  onDecide,
}: PhaseProposalCardProps) {
  const blocked = proposal.applicability === "blocked";
  const payload = proposal.proposal.payload;
  const safeHint =
    !blocked &&
    proposal.status === "unreviewed" &&
    isSafeForCodexPhaseBulkApprove(proposal.safety);

  return (
    <div
      className={`flex flex-col gap-1.5 border-b border-border px-2 py-2 last:border-b-0 ${
        selected ? "bg-accent/50" : "hover:bg-accent/30"
      }`}
      data-testid={`phase-proposal-card-${proposal.proposalId}`}
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
            {proposal.entityLabel} · anchor {payload.anchorDocumentRef} ·{" "}
            {bindingLabel(proposal)}
          </span>
          {proposal.valueDeltas.length > 0 && (
            <span className="mt-0.5 block text-[10px] text-foreground">
              {proposal.valueDeltas
                .map(
                  (delta) =>
                    `${delta.facetKey ?? delta.definitionRef}: ${delta.previousDisplay} → ${delta.nextDisplay}`,
                )
                .join(" · ")}
            </span>
          )}
          {proposal.existingPhaseCandidates.length > 0 && (
            <span className="block text-[10px] text-muted-foreground">
              既存候補:{" "}
              {proposal.existingPhaseCandidates
                .map((candidate) => `${candidate.ref}(${candidate.score})`)
                .join(", ")}
            </span>
          )}
          {blocked && (
            <span className="block text-[10px] text-amber-700 dark:text-amber-400">
              {proposal.blockedReason ?? "要解決"}
            </span>
          )}
          {safeHint && (
            <span className="block text-[10px] text-emerald-700 dark:text-emerald-400">
              安全一括承認の対象
            </span>
          )}
        </span>
      </button>

      {proposal.persistence && (
        <div className="pl-6">
          <PersistenceEvidence persistence={proposal.persistence} />
        </div>
      )}

      {!blocked && (
        <div className="flex flex-wrap gap-1 pl-6">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10 disabled:opacity-40"
            disabled={proposal.status === "approved"}
            onClick={() => onDecide?.("approved")}
            data-testid={`phase-approve-${proposal.proposalId}`}
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
