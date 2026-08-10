import type {
  ChronicleReviewProposal,
  ProbableDuplicateChoice,
} from "./chronicleExtractionStore";
import { isSafeForBulkApprove } from "./chronicleExtractionStore";
import type { NarrativeProposalStatus } from "@/features/narrative-extraction/runtime/types";

export interface ChronicleProposalCardProps {
  readonly proposal: ChronicleReviewProposal;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
  readonly onDecide?: (status: Exclude<NarrativeProposalStatus, "unreviewed">) => void;
  readonly onDuplicateChoice?: (choice: ProbableDuplicateChoice) => void;
}

function statusGlyph(proposal: ChronicleReviewProposal): string {
  if (proposal.applicability === "already-satisfied") return "✓";
  if (proposal.match.status === "probable-duplicate") return "⚠";
  if (proposal.status === "approved") return "☑";
  if (proposal.status === "rejected") return "☒";
  if (proposal.status === "deferred" || proposal.status === "held") return "…";
  return "□";
}

/**
 * Compact list-row card with approve/reject/defer and probable-duplicate choices.
 */
export function ChronicleProposalCard({
  proposal,
  selected = false,
  onSelect,
  onDecide,
  onDuplicateChoice,
}: ChronicleProposalCardProps) {
  const alreadySatisfied = proposal.applicability === "already-satisfied";
  const probable =
    proposal.match.status === "probable-duplicate"
      ? proposal.match
      : null;
  const safeHint =
    !alreadySatisfied &&
    proposal.status === "unreviewed" &&
    isSafeForBulkApprove(proposal.safety);

  return (
    <div
      className={`flex flex-col gap-1.5 border-b border-border px-2 py-2 last:border-b-0 ${
        selected ? "bg-accent/50" : "hover:bg-accent/30"
      }`}
      data-testid={`chronicle-proposal-card-${proposal.proposalId}`}
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
          {alreadySatisfied && (
            <span className="block text-[10px] text-muted-foreground">
              既に同じEventが登録されています（適用不要）
            </span>
          )}
          {probable && (
            <span className="block text-[10px] text-amber-700 dark:text-amber-400">
              既存Eventと同一の可能性があります
            </span>
          )}
          {safeHint && (
            <span className="block text-[10px] text-emerald-700 dark:text-emerald-400">
              安全一括承認の対象
            </span>
          )}
        </span>
      </button>

      {!alreadySatisfied && (
        <div className="flex flex-wrap gap-1 pl-6">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10 disabled:opacity-40"
            disabled={proposal.status === "approved"}
            onClick={() => onDecide?.("approved")}
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

      {probable && (
        <div
          className="flex flex-col gap-1 pl-6"
          data-testid={`chronicle-duplicate-choices-${proposal.proposalId}`}
        >
          <p className="text-[10px] text-muted-foreground">
            既存Event「{probable.candidates[0] ?? "不明"}」との重複候補
          </p>
          <div className="flex flex-wrap gap-1">
            {(
              [
                ["skip-as-same", "同じものとしてスキップ"],
                ["create-as-new", "別Eventとして作成"],
                ["hold", "保留"],
              ] as const
            ).map(([choice, label]) => (
              <button
                key={choice}
                type="button"
                className={`rounded border px-1.5 py-0.5 text-[10px] ${
                  proposal.probableDuplicateChoice === choice
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-accent"
                }`}
                onClick={() => onDuplicateChoice?.(choice)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
