import type { PhasePersistenceDecision } from "@/features/narrative-extraction/ir/inferences/phaseBoundary";

export interface PersistenceEvidenceProps {
  readonly persistence: PhasePersistenceDecision | null;
  readonly transitions?: readonly {
    readonly facetKey: string;
    readonly durability: string;
    readonly magnitude: string;
  }[];
}

/**
 * Shows why a Phase boundary was gated for persistence (proposal / report-only / rejected).
 */
export function PersistenceEvidence({
  persistence,
  transitions = [],
}: PersistenceEvidenceProps) {
  if (!persistence) {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid="persistence-evidence-empty"
      >
        永続化根拠がありません
      </p>
    );
  }

  const kindLabel =
    persistence.kind === "proposal"
      ? "Proposal 対象"
      : persistence.kind === "report-only"
        ? "報告のみ"
        : "却下";

  return (
    <section
      className="flex flex-col gap-1.5"
      data-testid="persistence-evidence"
    >
      <h4 className="text-xs font-medium text-muted-foreground">
        永続化サポート根拠
      </h4>
      <p className="text-xs text-foreground">
        {kindLabel}
        <span className="text-muted-foreground"> · {persistence.reason}</span>
      </p>
      {transitions.length > 0 && (
        <ul className="flex flex-col gap-1">
          {transitions.map((item, index) => (
            <li
              key={`${item.facetKey}-${index}`}
              className="rounded border border-border px-2 py-1 text-[10px] text-muted-foreground"
              data-testid={`persistence-transition-${index}`}
            >
              {item.facetKey} · {item.durability} · {item.magnitude}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
