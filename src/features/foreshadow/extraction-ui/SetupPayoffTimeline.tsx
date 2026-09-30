import { useTranslation } from "react-i18next";
import type { PlannedForeshadowProposal } from "@/features/foreshadow/extraction/proposalPlanner";

export interface SetupPayoffTimelineProps {
  readonly proposals: readonly PlannedForeshadowProposal[];
  readonly documentLabel?: (documentRef: string) => string;
}

interface TimelineNode {
  readonly documentRef: string;
  readonly kind: "setup" | "payoff";
  readonly threadTitle: string;
}

/**
 * Minimal reading-order timeline of setup/payoff marker proposals across threads.
 * Presentational only — ordering uses documentRef lexicographic sort as stub.
 */
export function SetupPayoffTimeline({
  proposals,
  documentLabel,
}: SetupPayoffTimelineProps) {
  const { t } = useTranslation();

  const nodes: TimelineNode[] = [];
  for (const proposal of proposals) {
    const title = proposal.threadProposal.payload.title;
    for (const setup of proposal.setupProposals) {
      nodes.push({
        documentRef: setup.payload.documentRef,
        kind: "setup",
        threadTitle: title,
      });
    }
    for (const payoff of proposal.payoffProposals) {
      nodes.push({
        documentRef: payoff.payload.documentRef,
        kind: "payoff",
        threadTitle: title,
      });
    }
  }

  if (nodes.length === 0) return null;

  const sorted = [...nodes].sort((a, b) =>
    a.documentRef.localeCompare(b.documentRef),
  );

  return (
    <div
      data-testid="setup-payoff-timeline"
      className="rounded border border-border/60 bg-muted/20 px-2 py-2"
    >
      <p className="mb-1.5 text-[10px] font-medium text-muted-foreground">
        {t("foreshadow.reviewExtract.timeline", "Setup → Payoff タイムライン")}
      </p>
      <ol className="flex flex-wrap gap-1">
        {sorted.map((node, index) => (
          <li
            key={`${node.documentRef}-${node.kind}-${index}`}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
              node.kind === "setup"
                ? "bg-blue-500/10 text-blue-800 dark:text-blue-200"
                : "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
            }`}
            title={node.threadTitle}
          >
            <span>{node.kind === "setup" ? "S" : "P"}</span>
            <span className="max-w-[80px] truncate">
              {documentLabel?.(node.documentRef) ?? node.documentRef}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
