import { useTranslation } from "react-i18next";
import { describeBulkApprovalReasons } from "./chronicleBulkApprovalReasons";
import {
  describeReapprovalReason,
  describeRemoval,
  type ReapprovalTranslate,
} from "./chronicleReapprovalText";
import type {
  ChronicleReviewProposal,
  ProbableDuplicateChoice,
} from "./chronicleExtractionStore";
import { isBulkApprovalTarget } from "./chronicleExtractionStore";
import type { NarrativeProposalStatus } from "@/features/narrative-extraction/runtime/types";

export interface ChronicleProposalCardProps {
  readonly proposal: ChronicleReviewProposal;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
  readonly onDecide?: (
    status: Exclude<NarrativeProposalStatus, "unreviewed">,
  ) => void;
  readonly onDuplicateChoice?: (choice: ProbableDuplicateChoice) => void;
  /** SRD/1 RA7: re-approve this one proposal (Native decides if it can). */
  readonly onReapprove?: () => void;
  readonly disabled?: boolean;
}

/**
 * How an applied proposal stands now (SRD/1 RD1/RD2, Native's values only):
 * still applied, taken off because its event was removed, or not confirmed
 * because the re-read failed. `null` for a proposal that is not applied.
 */
export type AppliedState = "applied" | "removed" | "unverified";

export function appliedState(
  proposal: ChronicleReviewProposal,
): AppliedState | null {
  if (proposal.application === null) return null;
  if (proposal.redecide === "unverified") return "unverified";
  if (proposal.redecide?.rejectedBy === "event-removed") return "removed";
  return "applied";
}

function statusGlyph(proposal: ChronicleReviewProposal): string {
  const applied = appliedState(proposal);
  if (applied === "removed") return "☒";
  if (applied === "unverified") return "?";
  if (applied === "applied") return "✓";
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
  onReapprove,
  disabled = false,
}: ChronicleProposalCardProps) {
  const { t } = useTranslation();
  const alreadySatisfied = proposal.applicability === "already-satisfied";
  const applied = proposal.application !== null;
  const appliedNow = appliedState(proposal);
  const redecide =
    proposal.redecide !== null && proposal.redecide !== "unverified"
      ? proposal.redecide
      : null;
  const translate: ReapprovalTranslate = (key, fallback, values) =>
    t(key, fallback, values);
  const reapprovable =
    appliedNow === "removed" && redecide?.reapproval.available === true;
  const reapproveBlocked =
    appliedNow === "removed" && !reapprovable
      ? (describeReapprovalReason(redecide?.reapproval.reason, translate) ??
        t(
          "chronicle.extract.reapproveReason.unknown",
          "確かめられませんでした",
        ))
      : null;
  const probable =
    proposal.match.status === "probable-duplicate" ? proposal.match : null;
  // Native's judgement only (BAO/1, B3): the card never computes it.
  const bulkTarget =
    !alreadySatisfied && !applied && isBulkApprovalTarget(proposal);
  const reasonSentences =
    alreadySatisfied || applied || bulkTarget
      ? []
      : describeBulkApprovalReasons(
          proposal.bulkApproval,
          (key, fallback) => t(key, fallback),
          { omitDuplicate: probable !== null },
        );

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
          {appliedNow === "applied" && (
            <span className="block text-[10px] text-emerald-700 dark:text-emerald-400">
              取り込み済み（再適用しません）
            </span>
          )}
          {appliedNow === "removed" && redecide && (
            <span
              className="block text-[10px] text-amber-700 dark:text-amber-400"
              data-testid={`chronicle-proposal-removed-${proposal.proposalId}`}
            >
              {t(
                "chronicle.extract.removedRejection",
                "却下（出来事を消したため）",
              )}
              {" — "}
              {describeRemoval(redecide, translate)}
            </span>
          )}
          {appliedNow === "unverified" && (
            <span
              className="block text-[10px] text-muted-foreground"
              data-testid={`chronicle-proposal-unverified-${proposal.proposalId}`}
            >
              {t(
                "chronicle.extract.appliedUnverified",
                "取り込んだ出来事の状態を確かめられませんでした",
              )}
            </span>
          )}
          {probable && (
            <span className="block text-[10px] text-amber-700 dark:text-amber-400">
              既存Eventと同一の可能性があります
            </span>
          )}
          {bulkTarget && (
            <span
              className="block text-[10px] text-emerald-700 dark:text-emerald-400"
              data-testid={`chronicle-proposal-bulk-target-${proposal.proposalId}`}
            >
              {t("chronicle.extract.bulkTarget", "まとめて承認の対象")}
            </span>
          )}
          {reasonSentences.length > 0 && (
            <span
              className="block text-[10px] text-muted-foreground"
              data-testid={`chronicle-proposal-reasons-${proposal.proposalId}`}
            >
              {reasonSentences.join("　")}
            </span>
          )}
        </span>
      </button>

      {appliedNow === "removed" && (
        <div className="flex flex-wrap items-center gap-1 pl-6">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10 disabled:opacity-40"
            disabled={disabled || !reapprovable}
            onClick={() => onReapprove?.()}
            data-testid={`chronicle-proposal-reapprove-${proposal.proposalId}`}
          >
            {t("chronicle.extract.reapprove", "承認し直す")}
          </button>
          {reapproveBlocked && (
            <span
              className="text-[10px] text-muted-foreground"
              data-testid={`chronicle-proposal-reapprove-blocked-${proposal.proposalId}`}
            >
              {reapproveBlocked}
            </span>
          )}
        </div>
      )}

      {!alreadySatisfied && !applied && !probable && (
        <div className="flex flex-wrap gap-1 pl-6">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10 disabled:opacity-40"
            disabled={disabled || proposal.status === "approved"}
            onClick={() => onDecide?.("approved")}
          >
            承認
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
            disabled={disabled || proposal.status === "rejected"}
            onClick={() => onDecide?.("rejected")}
          >
            拒否
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
            disabled={
              disabled ||
              proposal.status === "deferred" ||
              proposal.status === "held"
            }
            onClick={() => onDecide?.("deferred")}
          >
            保留
          </button>
        </div>
      )}

      {!applied && probable && (
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
                disabled={disabled}
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
