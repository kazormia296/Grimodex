import { useMemo, useState } from "react";
import { CodexExtractionEvidencePane } from "../CodexExtractionEvidencePane";
import {
  isSafeForCodexBaseDetailBulkApprove,
  isSafeForCodexPhaseBulkApprove,
  useCodexStructureExtractionStore,
  type CodexBaseDetailReviewProposal,
  type CodexPhaseReviewProposal,
  type CodexReviewEvidenceQuote,
} from "../codexStructureExtractionStore";
import { BaseDetailProposalCard } from "./BaseDetailProposalCard";
import { DetailMappingPicker } from "./DetailMappingPicker";
import { DetailValueEditor } from "./DetailValueEditor";
import {
  EntityStateTimeline,
  groupStatePhaseTimeline,
} from "./EntityStateTimeline";
import { PhaseProposalCard } from "./PhaseProposalCard";
import { PhaseResolutionPreview } from "./PhaseResolutionPreview";
import { PersistenceEvidence } from "./PersistenceEvidence";

export interface CodexStatePhaseReviewProps {
  readonly baseDetailProposals?: readonly CodexBaseDetailReviewProposal[];
  readonly phaseProposals?: readonly CodexPhaseReviewProposal[];
  readonly selectedProposalId?: string | null;
  readonly onSelectProposal?: (
    proposalId: string,
    kind: "base" | "phase",
  ) => void;
  readonly onEvidenceClick?: (evidence: CodexReviewEvidenceQuote) => void;
  readonly mappingCandidates?: readonly {
    readonly definitionRef: string;
    readonly label: string;
  }[];
  readonly boundToStore?: boolean;
}

/**
 * States & Phases review: timeline + base/phase cards + safe bulk approve.
 */
export function CodexStatePhaseReview({
  baseDetailProposals: baseProp,
  phaseProposals: phaseProp,
  selectedProposalId: selectedProp,
  onSelectProposal,
  onEvidenceClick,
  mappingCandidates = [],
  boundToStore = true,
}: CodexStatePhaseReviewProps) {
  const storeProjection = useCodexStructureExtractionStore((s) => s.projection);
  const selectedBaseId = useCodexStructureExtractionStore(
    (s) => s.selectedBaseDetailProposalId,
  );
  const selectedPhaseId = useCodexStructureExtractionStore(
    (s) => s.selectedPhaseProposalId,
  );
  const selectBaseDetailProposal = useCodexStructureExtractionStore(
    (s) => s.selectBaseDetailProposal,
  );
  const selectPhaseProposal = useCodexStructureExtractionStore(
    (s) => s.selectPhaseProposal,
  );
  const updateBaseDetailProposalStatus = useCodexStructureExtractionStore(
    (s) => s.updateBaseDetailProposalStatus,
  );
  const updatePhaseProposalStatus = useCodexStructureExtractionStore(
    (s) => s.updatePhaseProposalStatus,
  );
  const reviseBaseDetailValue = useCodexStructureExtractionStore(
    (s) => s.reviseBaseDetailValue,
  );
  const bindBaseDetailDefinition = useCodexStructureExtractionStore(
    (s) => s.bindBaseDetailDefinition,
  );
  const resolvePhaseBinding = useCodexStructureExtractionStore(
    (s) => s.resolvePhaseBinding,
  );
  const bulkApproveSafe = useCodexStructureExtractionStore(
    (s) => s.bulkApproveSafe,
  );

  const baseDetailProposals = useMemo(
    () => baseProp ?? storeProjection?.baseDetailProposals ?? [],
    [baseProp, storeProjection?.baseDetailProposals],
  );
  const phaseProposals = useMemo(
    () => phaseProp ?? storeProjection?.phaseProposals ?? [],
    [phaseProp, storeProjection?.phaseProposals],
  );

  const [selectionKind, setSelectionKind] = useState<"base" | "phase" | null>(
    null,
  );

  const selectedProposalId =
    selectedProp !== undefined
      ? selectedProp
      : selectionKind === "base"
        ? selectedBaseId
        : selectionKind === "phase"
          ? selectedPhaseId
          : (selectedBaseId ?? selectedPhaseId);

  const selectedBase = useMemo(
    () =>
      baseDetailProposals.find(
        (proposal) => proposal.proposalId === selectedProposalId,
      ) ?? null,
    [baseDetailProposals, selectedProposalId],
  );
  const selectedPhase = useMemo(
    () =>
      phaseProposals.find(
        (proposal) => proposal.proposalId === selectedProposalId,
      ) ?? null,
    [phaseProposals, selectedProposalId],
  );

  const entities = useMemo(
    () => groupStatePhaseTimeline(baseDetailProposals, phaseProposals),
    [baseDetailProposals, phaseProposals],
  );

  const safeCount =
    baseDetailProposals.filter(
      (proposal) =>
        proposal.applicability === "applicable" &&
        proposal.status === "unreviewed" &&
        !proposal.application &&
        isSafeForCodexBaseDetailBulkApprove(proposal.safety),
    ).length +
    phaseProposals.filter(
      (proposal) =>
        proposal.applicability === "applicable" &&
        proposal.status === "unreviewed" &&
        !proposal.application &&
        isSafeForCodexPhaseBulkApprove(proposal.safety),
    ).length;

  const handleSelect = (proposalId: string, kind: "base" | "phase") => {
    setSelectionKind(kind);
    if (onSelectProposal) onSelectProposal(proposalId, kind);
    else if (boundToStore) {
      if (kind === "base") {
        selectBaseDetailProposal(proposalId);
        selectPhaseProposal(null);
      } else {
        selectPhaseProposal(proposalId);
        selectBaseDetailProposal(null);
      }
    }
  };

  return (
    <div
      className="grid min-h-[240px] grid-cols-1 gap-2 overflow-hidden rounded border border-border md:grid-cols-[minmax(180px,34%)_minmax(160px,30%)_1fr]"
      data-testid="codex-state-phase-review"
    >
      <div className="flex max-h-80 flex-col border-b border-border md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
          <span className="text-xs font-medium text-foreground">
            Entity Timeline
          </span>
          {boundToStore && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={safeCount === 0}
              onClick={() => bulkApproveSafe()}
              data-testid="codex-state-phase-bulk-approve-safe"
            >
              安全な提案をまとめて承認
              {safeCount > 0 ? ` (${safeCount})` : ""}
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <EntityStateTimeline
            entities={entities}
            selectedProposalId={selectedProposalId}
            onSelectProposal={handleSelect}
          />
        </div>
      </div>

      <div className="flex max-h-80 flex-col border-b border-border md:border-b-0 md:border-r">
        <div className="border-b border-border px-2 py-1.5 text-xs font-medium">
          Proposals
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {baseDetailProposals.map((proposal) => (
            <BaseDetailProposalCard
              key={proposal.proposalId}
              proposal={proposal}
              selected={proposal.proposalId === selectedProposalId}
              onSelect={() => handleSelect(proposal.proposalId, "base")}
              onDecide={(status) => {
                if (boundToStore) {
                  updateBaseDetailProposalStatus(proposal.proposalId, status);
                }
              }}
            />
          ))}
          {phaseProposals.map((proposal) => (
            <PhaseProposalCard
              key={proposal.proposalId}
              proposal={proposal}
              selected={proposal.proposalId === selectedProposalId}
              onSelect={() => handleSelect(proposal.proposalId, "phase")}
              onDecide={(status) => {
                if (boundToStore) {
                  updatePhaseProposalStatus(proposal.proposalId, status);
                }
              }}
            />
          ))}
          {baseDetailProposals.length === 0 && phaseProposals.length === 0 && (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              State / Phase 提案がありません
            </p>
          )}
        </div>
      </div>

      <div className="flex max-h-80 min-w-0 flex-col gap-3 overflow-y-auto px-3 py-2">
        <span className="text-xs font-medium text-foreground">詳細</span>
        {!selectedBase && !selectedPhase ? (
          <p className="text-xs text-muted-foreground">
            提案を選択してください
          </p>
        ) : selectedBase ? (
          <>
            {selectedBase.unbound && (
              <DetailMappingPicker
                facetKey={selectedBase.facetKey}
                candidates={mappingCandidates}
                selectedDefinitionRef={
                  selectedBase.proposal.payload.definitionRef || null
                }
                onBind={(definitionRef, options) => {
                  if (boundToStore) {
                    bindBaseDetailDefinition(
                      selectedBase.proposalId,
                      definitionRef,
                      options,
                    );
                  }
                }}
              />
            )}
            <DetailValueEditor
              value={selectedBase.proposal.payload.value}
              onChange={(value) => {
                if (boundToStore) {
                  reviseBaseDetailValue(selectedBase.proposalId, value);
                }
              }}
            />
            <CodexExtractionEvidencePane
              proposal={{
                evidence: selectedBase.evidence,
                blockedReason: selectedBase.blockedReason,
              }}
              onEvidenceClick={onEvidenceClick}
              hideBindingSummary
            />
          </>
        ) : selectedPhase ? (
          <>
            <PersistenceEvidence persistence={selectedPhase.persistence} />
            {selectedPhase.proposal.payload.binding.kind === "unresolved" &&
              boundToStore && (
                <div className="flex flex-wrap gap-1">
                  {selectedPhase.proposal.payload.binding.allowCreateNew && (
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-[10px] text-primary hover:bg-primary/10"
                      onClick={() =>
                        resolvePhaseBinding(selectedPhase.proposalId, {
                          kind: "create-new",
                        })
                      }
                      data-testid="phase-resolve-create-new"
                    >
                      新規 Phase 作成
                    </button>
                  )}
                  {selectedPhase.existingPhaseCandidates.map((candidate) => (
                    <button
                      key={candidate.ref}
                      type="button"
                      className="rounded px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent"
                      onClick={() =>
                        resolvePhaseBinding(selectedPhase.proposalId, {
                          kind: "bind-existing",
                          phaseRef: candidate.ref,
                          expectedVersion: 0,
                        })
                      }
                    >
                      既存 {candidate.ref}
                    </button>
                  ))}
                </div>
              )}
            <PhaseResolutionPreview
              entry={{
                summary: null,
                content: "",
                contextMode: "default",
              }}
              phases={[]}
            />
            <CodexExtractionEvidencePane
              proposal={{
                evidence: selectedPhase.evidence,
                blockedReason: selectedPhase.blockedReason,
              }}
              onEvidenceClick={onEvidenceClick}
              hideBindingSummary
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
