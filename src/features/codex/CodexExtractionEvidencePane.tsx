import { useTranslation } from "react-i18next";
import type {
  CodexReviewEvidenceQuote,
  CodexEntityReviewProposal,
} from "./codexStructureExtractionStore";
import { localizeBlockedReason } from "./extraction/blockedReasons";

export interface CodexExtractionEvidencePaneProps {
  readonly proposal: Pick<
    CodexEntityReviewProposal,
    "evidence" | "blockedReason"
  > & {
    readonly proposal?: {
      readonly payload?: {
        readonly binding?: CodexEntityReviewProposal["proposal"]["payload"]["binding"];
        readonly typeResolution?: CodexEntityReviewProposal["proposal"]["payload"]["typeResolution"];
        readonly aliases?: CodexEntityReviewProposal["proposal"]["payload"]["aliases"];
      };
    };
  };
  readonly onEvidenceClick?: (evidence: CodexReviewEvidenceQuote) => void;
  /** Hide entity-specific Binding section (Relation review). */
  readonly hideBindingSummary?: boolean;
  readonly bindingLabels?: {
    entityName?: string | null;
    typeLabel?: string | null;
  };
}

/**
 * Evidence quotes (+ optional binding / type summary) for Codex proposals.
 */
export function CodexExtractionEvidencePane({
  proposal,
  onEvidenceClick,
  hideBindingSummary = false,
  bindingLabels,
}: CodexExtractionEvidencePaneProps) {
  const { t } = useTranslation();
  const payload = proposal.proposal?.payload;
  const binding = payload?.binding;

  return (
    <div
      className="flex flex-col gap-3 text-sm"
      data-testid="codex-extraction-evidence-pane"
    >
      <section className="flex flex-col gap-1.5">
        <h4 className="text-xs font-medium text-muted-foreground">
          {t("codex.structureReview.evidence.title")}
        </h4>
        {proposal.evidence.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("codex.structureReview.evidence.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {proposal.evidence.map((item) => {
              const quote = (
                <>
                  <p className="text-xs text-foreground">「{item.quote}」</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {t("codex.structureReview.evidence.scene")}:{" "}
                    {item.sceneTitle ?? item.sceneId ?? item.documentRef}
                    {item.blocked || item.method === "fragmented"
                      ? ` · ${t("codex.structureReview.evidence.fragmentBlocked")}`
                      : ""}
                  </p>
                </>
              );
              const className =
                "w-full rounded border border-border bg-background px-2 py-1.5 text-left";
              return (
                <li key={item.anchorId}>
                  {onEvidenceClick && item.sceneId ? (
                    <button
                      type="button"
                      className={`${className} hover:bg-accent/40`}
                      onClick={() => onEvidenceClick(item)}
                      data-testid={`codex-evidence-quote-${item.anchorId}`}
                    >
                      {quote}
                    </button>
                  ) : (
                    <div
                      className={className}
                      data-testid={`codex-evidence-quote-${item.anchorId}`}
                    >
                      {quote}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {!hideBindingSummary && binding && payload && (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">
            {t("codex.structureReview.evidence.binding")}
          </h4>
          <p className="text-xs text-foreground">
            {binding.kind === "create-new"
              ? t("codex.structureReview.evidence.createNew")
              : binding.kind === "bind-existing"
                ? t("codex.structureReview.evidence.existingEntry", {
                    ref: bindingLabels?.entityName ?? binding.entityRef,
                  })
                : t("codex.structureReview.evidence.unresolved")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("codex.structureReview.evidence.type")}:{" "}
            {payload.typeResolution?.status === "resolved"
              ? (bindingLabels?.typeLabel ?? payload.typeResolution.typeRef)
              : payload.typeResolution?.status === "unresolved"
                ? t("codex.structureReview.evidence.unresolved")
                : (payload.typeResolution?.status ?? "—")}
          </p>
          {(payload.aliases?.length ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("codex.structureReview.evidence.alias")}:{" "}
              {payload.aliases!.map((alias) => alias.surface).join("、")}
            </p>
          )}
          {proposal.blockedReason && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              {localizeBlockedReason(proposal.blockedReason, t)}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
