import { useTranslation } from "react-i18next";
import type { CodexEntityReviewProposal } from "./codexStructureExtractionStore";
import { isSafeForCodexEntityBulkApprove } from "./codexStructureExtractionStore";
import type { NarrativeProposalStatus } from "@/features/narrative-extraction/runtime/types";

export interface CodexEntityProposalCardProps {
  readonly proposal: CodexEntityReviewProposal;
  readonly selected?: boolean;
  /** 結び先 Entry の名前（既存への結び付けのとき）。無ければ不透明な ref を出す。 */
  readonly targetName?: string;
  readonly onSelect?: () => void;
  readonly onDecide?: (
    status: Exclude<NarrativeProposalStatus, "unreviewed">,
  ) => void;
}

function statusGlyph(proposal: CodexEntityReviewProposal): string {
  if (proposal.applicability === "blocked") return "⊘";
  if (proposal.status === "approved") return "☑";
  if (proposal.status === "rejected") return "☒";
  if (proposal.status === "deferred" || proposal.status === "held") return "…";
  return "□";
}

function bindingLabel(
  proposal: CodexEntityReviewProposal,
  targetName: string | undefined,
  existingLabel: (name: string) => string,
): string {
  const binding = proposal.proposal.payload.binding;
  if (binding.kind === "create-new") return "新規作成";
  if (binding.kind === "bind-existing") {
    return existingLabel(targetName ?? binding.entityRef);
  }
  return "未解決";
}

/**
 * Compact list-row card for Codex Entity Binding proposals.
 */
export function CodexEntityProposalCard({
  proposal,
  selected = false,
  targetName,
  onSelect,
  onDecide,
}: CodexEntityProposalCardProps) {
  const { t } = useTranslation();
  const blocked = proposal.applicability === "blocked";
  const applied = Boolean(proposal.application);
  const safeHint =
    !blocked &&
    !applied &&
    proposal.status === "unreviewed" &&
    isSafeForCodexEntityBulkApprove(proposal.safety);

  return (
    <div
      className={`flex flex-col gap-1.5 border-b border-border px-2 py-2 last:border-b-0 ${
        selected ? "bg-accent/50" : "hover:bg-accent/30"
      }`}
      data-testid={`codex-entity-proposal-card-${proposal.proposalId}`}
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
            {bindingLabel(proposal, targetName, (name) =>
              t("codex.structureReview.bindingExisting", { name }),
            )}
          </span>
          {blocked && (
            <span className="block text-[10px] text-amber-700 dark:text-amber-400">
              {proposal.blockedReason ?? "要解決"}
            </span>
          )}
          {applied && (
            <span className="block text-[10px] text-muted-foreground">
              適用済み（編集不可）
            </span>
          )}
          {proposal.staleBind && (
            <span
              className="block text-[10px] text-amber-700 dark:text-amber-400"
              data-testid="codex-entity-stale-bind-note"
            >
              {t("codex.structureReview.staleBind")}
            </span>
          )}
          {safeHint && (
            <span className="block text-[10px] text-emerald-700 dark:text-emerald-400">
              {proposal.proposal.payload.binding.kind === "bind-existing"
                ? t("codex.structureReview.safeHintBind")
                : t("codex.structureReview.safeHintCreate")}
            </span>
          )}
        </span>
      </button>

      {!blocked && !applied && (
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
    </div>
  );
}
