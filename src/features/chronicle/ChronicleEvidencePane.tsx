import type {
  ChronicleReviewEvidenceQuote,
  ChronicleReviewProposal,
} from "./chronicleExtractionStore";

function actualityLabel(actuality: string | null | undefined): string {
  switch (actuality) {
    case "actual":
      return "実際に発生";
    case "attempted":
      return "試み（失敗含む）";
    case "prevented":
      return "阻止された";
    default:
      return actuality ?? "未確定";
  }
}

export interface ChronicleEvidencePaneProps {
  readonly proposal: ChronicleReviewProposal;
  readonly onEvidenceClick?: (evidence: ChronicleReviewEvidenceQuote) => void;
}

/**
 * Evidence quotes, inference summary, and unresolved metadata (display-only).
 */
export function ChronicleEvidencePane({
  proposal,
  onEvidenceClick,
}: ChronicleEvidencePaneProps) {
  const payload = proposal.payload;
  const unresolved = payload?.unresolvedMetadata;

  return (
    <div
      className="flex flex-col gap-3 text-sm"
      data-testid="chronicle-evidence-pane"
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
                  data-testid={`chronicle-evidence-quote-${item.anchorId}`}
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

      <section className="flex flex-col gap-1">
        <h4 className="text-xs font-medium text-muted-foreground">推論</h4>
        <p className="text-xs text-foreground">
          {actualityLabel(payload?.actuality)}
          {payload?.significance ? ` / ${payload.significance}` : ""}
        </p>
        {proposal.blockedReason && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400">
            {proposal.blockedReason}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h4 className="text-xs font-medium text-muted-foreground">
          未適用情報
        </h4>
        <p className="text-xs text-muted-foreground">
          参加者:{" "}
          {unresolved?.participantSurfaces?.length
            ? unresolved.participantSurfaces.join("、")
            : "—"}
        </p>
        <p className="text-xs text-muted-foreground">
          場所: {unresolved?.locationSurface ?? "—"}
        </p>
        {unresolved?.temporalExpressions &&
          unresolved.temporalExpressions.length > 0 && (
            <p className="text-xs text-muted-foreground">
              時刻表現: {unresolved.temporalExpressions.join("、")}
            </p>
          )}
      </section>
    </div>
  );
}
