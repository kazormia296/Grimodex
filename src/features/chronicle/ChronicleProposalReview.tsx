import { useMemo, useState } from "react";
import { ChronicleEvidencePane } from "./ChronicleEvidencePane";
import { ChronicleProposalCard } from "./ChronicleProposalCard";
import {
  isSafeForBulkApprove,
  useChronicleExtractionStore,
  type ChronicleReviewEvidenceQuote,
  type ChronicleReviewProposal,
} from "./chronicleExtractionStore";

export interface ChronicleProposalReviewProps {
  readonly proposals?: readonly ChronicleReviewProposal[];
  readonly selectedProposalId?: string | null;
  readonly onSelectProposal?: (proposalId: string) => void;
  readonly onEvidenceClick?: (evidence: ChronicleReviewEvidenceQuote) => void;
  /** When true, reads/writes the chronicleExtractionStore. */
  readonly boundToStore?: boolean;
}

/**
 * Proposal list + detail split layout (spec §16).
 */
export function ChronicleProposalReview({
  proposals: proposalsProp,
  selectedProposalId: selectedProp,
  onSelectProposal,
  onEvidenceClick,
  boundToStore = true,
}: ChronicleProposalReviewProps) {
  const storeProjection = useChronicleExtractionStore((s) => s.projection);
  const storeSelected = useChronicleExtractionStore((s) => s.selectedProposalId);
  const selectProposal = useChronicleExtractionStore((s) => s.selectProposal);
  const updateProposalStatus = useChronicleExtractionStore(
    (s) => s.updateProposalStatus,
  );
  const setProbableDuplicateChoice = useChronicleExtractionStore(
    (s) => s.setProbableDuplicateChoice,
  );
  const reviseProposalFields = useChronicleExtractionStore(
    (s) => s.reviseProposalFields,
  );
  const bulkApproveSafe = useChronicleExtractionStore((s) => s.bulkApproveSafe);

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

  const [draftTitle, setDraftTitle] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState<string | null>(null);

  const titleValue =
    draftTitle ?? selected?.payload?.title ?? selected?.displayTitle ?? "";
  const noteValue = draftNote ?? selected?.payload?.note ?? "";

  const handleSelect = (proposalId: string) => {
    setDraftTitle(null);
    setDraftNote(null);
    if (onSelectProposal) onSelectProposal(proposalId);
    else if (boundToStore) selectProposal(proposalId);
  };

  const safeCount = proposals.filter(
    (proposal) =>
      proposal.applicability === "applicable" &&
      proposal.status === "unreviewed" &&
      isSafeForBulkApprove(proposal.safety),
  ).length;

  return (
    <div
      className="grid min-h-[220px] grid-cols-1 gap-2 overflow-hidden rounded border border-border md:grid-cols-[minmax(180px,38%)_1fr]"
      data-testid="chronicle-proposal-review"
    >
      <div className="flex max-h-80 flex-col border-b border-border md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
          <span className="text-xs font-medium text-foreground">
            Proposal一覧
          </span>
          {boundToStore && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={safeCount === 0}
              onClick={() => bulkApproveSafe()}
              data-testid="chronicle-bulk-approve-safe"
            >
              安全な提案をまとめて承認
              {safeCount > 0 ? ` (${safeCount})` : ""}
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {proposals.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              抽出できるイベントが見つかりませんでした。
            </p>
          ) : (
            proposals.map((proposal) => (
              <ChronicleProposalCard
                key={proposal.proposalId}
                proposal={proposal}
                selected={proposal.proposalId === selectedProposalId}
                onSelect={() => handleSelect(proposal.proposalId)}
                onDecide={(status) => {
                  if (boundToStore) {
                    updateProposalStatus(proposal.proposalId, status);
                  }
                }}
                onDuplicateChoice={(choice) => {
                  if (boundToStore) {
                    setProbableDuplicateChoice(proposal.proposalId, choice);
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
        ) : selected.applicability === "already-satisfied" ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{selected.displayTitle}</p>
            <p className="text-xs text-muted-foreground">
              既に同じEventが登録されています。適用不要・完了扱いです。
            </p>
            <ChronicleEvidencePane
              proposal={selected}
              onEvidenceClick={onEvidenceClick}
            />
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">タイトル</span>
              <input
                className="rounded border border-border bg-background px-2 py-1 text-sm focus:outline-none"
                value={titleValue}
                disabled={!boundToStore}
                onChange={(event) => setDraftTitle(event.target.value)}
                onBlur={() => {
                  if (!boundToStore || draftTitle === null) return;
                  reviseProposalFields(selected.proposalId, {
                    title: draftTitle,
                  });
                  setDraftTitle(null);
                }}
                data-testid="chronicle-proposal-title-input"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">補足</span>
              <textarea
                className="min-h-[52px] rounded border border-border bg-background px-2 py-1 text-sm focus:outline-none"
                value={noteValue}
                disabled={!boundToStore}
                onChange={(event) => setDraftNote(event.target.value)}
                onBlur={() => {
                  if (!boundToStore || draftNote === null) return;
                  reviseProposalFields(selected.proposalId, {
                    note: draftNote,
                  });
                  setDraftNote(null);
                }}
                data-testid="chronicle-proposal-note-input"
              />
            </label>
            {selected.payload && (
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={selected.payload.disclosure.secret}
                    disabled={!boundToStore}
                    onChange={(event) =>
                      reviseProposalFields(selected.proposalId, {
                        secret: event.target.checked,
                      })
                    }
                    data-testid="chronicle-proposal-secret-input"
                  />
                  <span className="text-muted-foreground">secret</span>
                </label>
                <label className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="shrink-0 text-muted-foreground">
                    reveal Scene
                  </span>
                  <input
                    className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-0.5 text-[11px] focus:outline-none"
                    value={selected.payload.disclosure.revealDocumentRef}
                    disabled={!boundToStore}
                    onChange={(event) =>
                      reviseProposalFields(selected.proposalId, {
                        revealDocumentRef: event.target.value,
                      })
                    }
                    data-testid="chronicle-proposal-reveal-input"
                  />
                </label>
              </div>
            )}
            <ChronicleEvidencePane
              proposal={selected}
              onEvidenceClick={onEvidenceClick}
            />
          </>
        )}
      </div>
    </div>
  );
}
