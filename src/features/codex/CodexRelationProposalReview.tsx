import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CodexExtractionEvidencePane } from "./CodexExtractionEvidencePane";
import { CodexRelationEditor } from "./CodexRelationEditor";
import { CodexRelationProposalCard } from "./CodexRelationProposalCard";
import { decideCodexStructureProposal } from "./codexStructureExtractionApi";
import {
  reviseCodexStructureRelation,
  swapCodexStructureRelationEndpoints,
} from "./codexStructureExtractionApi";
import {
  useCodexStructureExtractionStore,
  type CodexRelationReviewProposal,
  type CodexReviewEvidenceQuote,
} from "./codexStructureExtractionStore";

export interface CodexRelationProposalReviewProps {
  readonly proposals?: readonly CodexRelationReviewProposal[];
  readonly selectedProposalId?: string | null;
  readonly onSelectProposal?: (proposalId: string) => void;
  readonly onEvidenceClick?: (evidence: CodexReviewEvidenceQuote) => void;
  /** When true, reads/writes the codexStructureExtractionStore. */
  readonly boundToStore?: boolean;
}

/**
 * Relation Proposal list + detail. Bulk approve is disabled (spec §22).
 */
export function CodexRelationProposalReview({
  proposals: proposalsProp,
  selectedProposalId: selectedProp,
  onSelectProposal,
  onEvidenceClick,
  boundToStore = true,
}: CodexRelationProposalReviewProps) {
  const { t } = useTranslation();
  const storeProjection = useCodexStructureExtractionStore((s) => s.projection);
  const storeSelected = useCodexStructureExtractionStore(
    (s) => s.selectedRelationProposalId,
  );
  const selectRelationProposal = useCodexStructureExtractionStore(
    (s) => s.selectRelationProposal,
  );

  const proposals = useMemo(
    () => proposalsProp ?? storeProjection?.relationProposals ?? [],
    [proposalsProp, storeProjection?.relationProposals],
  );
  const selectedProposalId =
    selectedProp !== undefined
      ? selectedProp
      : boundToStore
        ? storeSelected
        : (proposals[0]?.proposalId ?? null);

  const selected = useMemo(
    () =>
      proposals.find(
        (proposal) => proposal.proposalId === selectedProposalId,
      ) ?? null,
    [proposals, selectedProposalId],
  );

  const handleSelect = (proposalId: string) => {
    if (onSelectProposal) onSelectProposal(proposalId);
    else if (boundToStore) selectRelationProposal(proposalId);
  };

  return (
    <div
      className="grid min-h-[220px] grid-cols-1 gap-2 overflow-hidden rounded border border-border md:grid-cols-[minmax(180px,38%)_1fr]"
      data-testid="codex-relation-proposal-review"
    >
      <div className="flex max-h-80 flex-col border-b border-border md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
          <span className="text-xs font-medium text-foreground">
            {t("codex.structureReview.relationReview.title")}
          </span>
          <span
            className="text-[10px] text-muted-foreground"
            data-testid="codex-relation-bulk-approve-disabled"
            title={t("codex.structureReview.relationReview.bulkApproveTitle")}
          >
            {t("codex.structureReview.relationReview.noBulkApprove")}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {proposals.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              {t("codex.structureReview.relationReview.noRelations")}
            </p>
          ) : (
            proposals.map((proposal) => (
              <CodexRelationProposalCard
                key={proposal.proposalId}
                proposal={proposal}
                selected={proposal.proposalId === selectedProposalId}
                onSelect={() => handleSelect(proposal.proposalId)}
                onDecide={(status) => {
                  if (!boundToStore) return;
                  void decideCodexStructureProposal({
                    proposalId: proposal.proposalId,
                    status,
                    kind: "relation",
                  });
                }}
              />
            ))
          )}
        </div>
      </div>

      <div className="flex max-h-80 min-w-0 flex-col gap-3 overflow-y-auto px-3 py-2">
        <span className="text-xs font-medium text-foreground">
          {t("codex.structureReview.relationReview.details")}
        </span>
        {!selected ? (
          <p className="text-xs text-muted-foreground">
            {t("codex.structureReview.relationReview.selectProposal")}
          </p>
        ) : (
          <>
            {boundToStore &&
              !selected.application &&
              selected.applicability !== "already-satisfied" && (
                <CodexRelationEditor
                  proposal={selected}
                  onChange={(patch) =>
                    void reviseCodexStructureRelation({
                      proposalId: selected.proposalId,
                      patch,
                    })
                  }
                  onSwapEndpoints={() =>
                    void swapCodexStructureRelationEndpoints({
                      proposalId: selected.proposalId,
                    })
                  }
                />
              )}
            {selected.application && (
              <p
                className="text-[10px] text-muted-foreground"
                data-testid="codex-relation-applied-readonly"
              >
                {t("codex.structureReview.relationReview.appliedReadonly")}
              </p>
            )}
            {!selected.application &&
              selected.applicability === "already-satisfied" && (
                <p
                  className="text-[10px] text-muted-foreground"
                  data-testid="codex-relation-already-satisfied-readonly"
                >
                  {t(
                    "codex.structureReview.relationReview.alreadySatisfiedReadonly",
                  )}
                </p>
              )}
            <CodexExtractionEvidencePane
              proposal={{
                evidence: selected.evidence,
                blockedReason: selected.blockedReason,
              }}
              hideBindingSummary
              onEvidenceClick={onEvidenceClick}
            />
          </>
        )}
      </div>
    </div>
  );
}
