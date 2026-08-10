import type {
  CodexBaseDetailReviewProposal,
  CodexPhaseReviewProposal,
} from "../codexStructureExtractionStore";
import { formatProjectedDetailValue } from "./BaseDetailProposalCard";

export interface EntityStateTimelineEntity {
  readonly entityId: string;
  readonly entityLabel: string;
  readonly baseProposals: readonly CodexBaseDetailReviewProposal[];
  readonly phaseProposals: readonly CodexPhaseReviewProposal[];
}

export interface EntityStateTimelineProps {
  readonly entities: readonly EntityStateTimelineEntity[];
  readonly selectedProposalId?: string | null;
  readonly onSelectProposal?: (proposalId: string, kind: "base" | "phase") => void;
}

/**
 * Per-entity timeline: Base Detail rows then Phase rows.
 */
export function EntityStateTimeline({
  entities,
  selectedProposalId = null,
  onSelectProposal,
}: EntityStateTimelineProps) {
  if (entities.length === 0) {
    return (
      <p
        className="px-3 py-3 text-xs text-muted-foreground"
        data-testid="entity-state-timeline-empty"
      >
        State / Phase 提案がありません
      </p>
    );
  }

  return (
    <div
      className="flex flex-col gap-3 overflow-y-auto"
      data-testid="entity-state-timeline"
    >
      {entities.map((entity) => (
        <section
          key={entity.entityId}
          className="flex flex-col gap-1"
          data-testid={`entity-state-timeline-${entity.entityId}`}
        >
          <h4 className="px-2 text-xs font-medium text-foreground">
            {entity.entityLabel}
          </h4>
          <div className="flex flex-col border-l-2 border-border pl-2">
            {entity.baseProposals.map((proposal) => {
              const selected = proposal.proposalId === selectedProposalId;
              return (
                <button
                  key={proposal.proposalId}
                  type="button"
                  className={`rounded px-2 py-1.5 text-left text-[11px] ${
                    selected ? "bg-accent/50" : "hover:bg-accent/30"
                  }`}
                  onClick={() =>
                    onSelectProposal?.(proposal.proposalId, "base")
                  }
                  data-testid={`timeline-base-${proposal.proposalId}`}
                >
                  <span className="font-medium text-foreground">Base</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {proposal.facetKey} ·{" "}
                    {formatProjectedDetailValue(proposal.existingValue)} →{" "}
                    {formatProjectedDetailValue(proposal.proposal.payload.value)}
                  </span>
                </button>
              );
            })}
            {entity.phaseProposals.map((proposal) => {
              const selected = proposal.proposalId === selectedProposalId;
              const label =
                proposal.proposal.payload.labelSuggestion ??
                proposal.displayTitle;
              return (
                <button
                  key={proposal.proposalId}
                  type="button"
                  className={`rounded px-2 py-1.5 text-left text-[11px] ${
                    selected ? "bg-accent/50" : "hover:bg-accent/30"
                  }`}
                  onClick={() =>
                    onSelectProposal?.(proposal.proposalId, "phase")
                  }
                  data-testid={`timeline-phase-${proposal.proposalId}`}
                >
                  <span className="font-medium text-foreground">Phase</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {label} @ {proposal.proposal.payload.anchorDocumentRef}
                  </span>
                </button>
              );
            })}
            {entity.baseProposals.length === 0 &&
              entity.phaseProposals.length === 0 && (
                <p className="px-2 py-1 text-[10px] text-muted-foreground">
                  行なし
                </p>
              )}
          </div>
        </section>
      ))}
    </div>
  );
}

export function groupStatePhaseTimeline(
  baseProposals: readonly CodexBaseDetailReviewProposal[],
  phaseProposals: readonly CodexPhaseReviewProposal[],
): EntityStateTimelineEntity[] {
  type MutableEntity = {
    entityId: string;
    entityLabel: string;
    baseProposals: CodexBaseDetailReviewProposal[];
    phaseProposals: CodexPhaseReviewProposal[];
  };
  const byEntity = new Map<string, MutableEntity>();

  const ensure = (entityId: string, entityLabel: string): MutableEntity => {
    const existing = byEntity.get(entityId);
    if (existing) return existing;
    const created: MutableEntity = {
      entityId,
      entityLabel,
      baseProposals: [],
      phaseProposals: [],
    };
    byEntity.set(entityId, created);
    return created;
  };

  for (const proposal of baseProposals) {
    const entityId = proposal.proposal.payload.narrativeEntityId;
    ensure(entityId, proposal.entityLabel).baseProposals.push(proposal);
  }
  for (const proposal of phaseProposals) {
    const entityId = proposal.proposal.payload.narrativeEntityId;
    ensure(entityId, proposal.entityLabel).phaseProposals.push(proposal);
  }

  return [...byEntity.values()];
}
