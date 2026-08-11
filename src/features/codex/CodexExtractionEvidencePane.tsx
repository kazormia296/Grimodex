import type {
  CodexReviewEvidenceQuote,
  CodexEntityReviewProposal,
} from "./codexStructureExtractionStore";

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
}

/**
 * Evidence quotes (+ optional binding / type summary) for Codex proposals.
 */
export function CodexExtractionEvidencePane({
  proposal,
  onEvidenceClick,
  hideBindingSummary = false,
}: CodexExtractionEvidencePaneProps) {
  const payload = proposal.proposal?.payload;
  const binding = payload?.binding;

  return (
    <div
      className="flex flex-col gap-3 text-sm"
      data-testid="codex-extraction-evidence-pane"
    >
      <section className="flex flex-col gap-1.5">
        <h4 className="text-xs font-medium text-muted-foreground">根拠引用</h4>
        {proposal.evidence.length === 0 ? (
          <p className="text-xs text-muted-foreground">根拠がありません</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {proposal.evidence.map((item) => (
              <li key={item.anchorId}>
                <button
                  type="button"
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-left hover:bg-accent/40 disabled:cursor-default"
                  onClick={() => onEvidenceClick?.(item)}
                  disabled={!onEvidenceClick}
                  data-testid={`codex-evidence-quote-${item.anchorId}`}
                >
                  <p className="text-xs text-foreground">「{item.quote}」</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    Scene: {item.sceneTitle ?? item.sceneId ?? item.documentRef}
                    {item.blocked || item.method === "fragmented"
                      ? " · 断片（適用不可）"
                      : ""}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!hideBindingSummary && binding && payload && (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">Binding</h4>
          <p className="text-xs text-foreground">
            {binding.kind === "create-new"
              ? "新規作成"
              : binding.kind === "bind-existing"
                ? `既存 Entry（${binding.entityRef}）`
                : "未解決"}
          </p>
          <p className="text-xs text-muted-foreground">
            Type:{" "}
            {payload.typeResolution?.status === "resolved"
              ? payload.typeResolution.typeRef
              : (payload.typeResolution?.status ?? "—")}
          </p>
          {(payload.aliases?.length ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground">
              Alias: {payload.aliases!.map((alias) => alias.surface).join("、")}
            </p>
          )}
          {proposal.blockedReason && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              {proposal.blockedReason}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
