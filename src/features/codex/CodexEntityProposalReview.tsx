import { useMemo, useState } from "react";
import { CodexExtractionEvidencePane } from "./CodexExtractionEvidencePane";
import { CodexEntityProposalCard } from "./CodexEntityProposalCard";
import { CodexEntityResolutionPicker } from "./CodexEntityResolutionPicker";
import {
  isSafeForCodexEntityBulkApprove,
  useCodexStructureExtractionStore,
  type CodexEntityReviewProposal,
  type CodexReviewEvidenceQuote,
} from "./codexStructureExtractionStore";

export interface CodexEntityProposalReviewProps {
  readonly proposals?: readonly CodexEntityReviewProposal[];
  readonly selectedProposalId?: string | null;
  readonly onSelectProposal?: (proposalId: string) => void;
  readonly onEvidenceClick?: (evidence: CodexReviewEvidenceQuote) => void;
  /** When true, reads/writes the codexStructureExtractionStore. */
  readonly boundToStore?: boolean;
}

/**
 * Entity Proposal list + detail split (mirrors Chronicle Proposal Review).
 */
export function CodexEntityProposalReview({
  proposals: proposalsProp,
  selectedProposalId: selectedProp,
  onSelectProposal,
  onEvidenceClick,
  boundToStore = true,
}: CodexEntityProposalReviewProps) {
  const storeProjection = useCodexStructureExtractionStore((s) => s.projection);
  const storeSelected = useCodexStructureExtractionStore(
    (s) => s.selectedProposalId,
  );
  const selectProposal = useCodexStructureExtractionStore(
    (s) => s.selectProposal,
  );
  const updateProposalStatus = useCodexStructureExtractionStore(
    (s) => s.updateProposalStatus,
  );
  const resolveBinding = useCodexStructureExtractionStore(
    (s) => s.resolveBinding,
  );
  const reviseProposalFields = useCodexStructureExtractionStore(
    (s) => s.reviseProposalFields,
  );
  const bulkApproveSafe = useCodexStructureExtractionStore(
    (s) => s.bulkApproveSafe,
  );

  const proposals = proposalsProp ?? storeProjection?.proposals ?? [];
  const selectedProposalId =
    selectedProp !== undefined
      ? selectedProp
      : boundToStore
        ? storeSelected
        : (proposals[0]?.proposalId ?? null);

  const selected = useMemo(
    () =>
      proposals.find((proposal) => proposal.proposalId === selectedProposalId) ??
      null,
    [proposals, selectedProposalId],
  );

  const [draftName, setDraftName] = useState<string | null>(null);
  const [draftSummary, setDraftSummary] = useState<string | null>(null);

  const nameValue =
    draftName ?? selected?.proposal.payload.canonicalName ?? selected?.displayTitle ?? "";
  const summaryValue = (() => {
    if (draftSummary !== null) return draftSummary;
    if (!selected) return "";
    const binding = selected.proposal.payload.binding;
    if (binding.kind === "create-new") return binding.entry.summary ?? "";
    if (
      binding.kind === "bind-existing" &&
      binding.enrichment.summary.kind === "fill-if-empty"
    ) {
      return binding.enrichment.summary.value;
    }
    return "";
  })();

  const handleSelect = (proposalId: string) => {
    setDraftName(null);
    setDraftSummary(null);
    if (onSelectProposal) onSelectProposal(proposalId);
    else if (boundToStore) selectProposal(proposalId);
  };

  const safeCount = proposals.filter(
    (proposal) =>
      proposal.applicability === "applicable" &&
      proposal.status === "unreviewed" &&
      isSafeForCodexEntityBulkApprove(proposal.safety),
  ).length;

  const unresolvedBinding =
    selected?.proposal.payload.binding.kind === "unresolved"
      ? selected.proposal.payload.binding
      : null;

  return (
    <div
      className="grid min-h-[220px] grid-cols-1 gap-2 overflow-hidden rounded border border-border md:grid-cols-[minmax(180px,38%)_1fr]"
      data-testid="codex-entity-proposal-review"
    >
      <div className="flex max-h-80 flex-col border-b border-border md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
          <span className="text-xs font-medium text-foreground">
            Entity Proposal
          </span>
          {boundToStore && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={safeCount === 0}
              onClick={() => bulkApproveSafe()}
              data-testid="codex-bulk-approve-safe"
            >
              安全な提案をまとめて承認
              {safeCount > 0 ? ` (${safeCount})` : ""}
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {proposals.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              抽出できる Entity が見つかりませんでした。
            </p>
          ) : (
            proposals.map((proposal) => (
              <CodexEntityProposalCard
                key={proposal.proposalId}
                proposal={proposal}
                selected={proposal.proposalId === selectedProposalId}
                onSelect={() => handleSelect(proposal.proposalId)}
                onDecide={(status) => {
                  if (boundToStore) {
                    updateProposalStatus(proposal.proposalId, status);
                  }
                }}
              />
            ))
          )}
        </div>
      </div>

      <div className="flex max-h-80 min-w-0 flex-col gap-3 overflow-y-auto px-3 py-2">
        <span className="text-xs font-medium text-foreground">詳細</span>
        {!selected ? (
          <p className="text-xs text-muted-foreground">提案を選択してください</p>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Canonical Name</span>
              <input
                className="rounded border border-input bg-background px-2 py-1 text-sm"
                value={nameValue}
                onChange={(event) => setDraftName(event.target.value)}
                onBlur={() => {
                  if (!boundToStore || draftName === null) return;
                  reviseProposalFields(selected.proposalId, {
                    canonicalName: draftName,
                  });
                  setDraftName(null);
                }}
                data-testid="codex-entity-name-input"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Summary</span>
              <textarea
                className="min-h-[64px] rounded border border-input bg-background px-2 py-1 text-sm"
                value={summaryValue}
                onChange={(event) => setDraftSummary(event.target.value)}
                onBlur={() => {
                  if (!boundToStore || draftSummary === null) return;
                  reviseProposalFields(selected.proposalId, {
                    summary: draftSummary,
                  });
                  setDraftSummary(null);
                }}
                data-testid="codex-entity-summary-input"
              />
            </label>

            {unresolvedBinding && boundToStore && (
              <CodexEntityResolutionPicker
                allowCreateNew={unresolvedBinding.allowCreateNew}
                candidates={unresolvedBinding.candidates}
                onCreateNew={() =>
                  resolveBinding(selected.proposalId, { kind: "create-new" })
                }
                onUseExisting={(entityRef) =>
                  resolveBinding(selected.proposalId, {
                    kind: "bind-existing",
                    entityRef,
                  })
                }
              />
            )}

            <CodexExtractionEvidencePane
              proposal={selected}
              onEvidenceClick={onEvidenceClick}
            />
          </>
        )}
      </div>
    </div>
  );
}
