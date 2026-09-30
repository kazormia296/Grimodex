import { ArrowLeft, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { BatchImpactRail } from "./BatchImpactRail";
import { BatchProposalList } from "./BatchProposalList";
import { BatchReviewFooter } from "./BatchReviewFooter";
import { ProjectionPipeline } from "./ProjectionPipeline";
import { ProjectionWorkGraph } from "./ProjectionWorkGraph";
import { useWorkLayer } from "./WorkLayerContext";

export function BatchReview() {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  const [selectedIds, setSelectedIds] = useState<readonly string[] | null>(
    null,
  );
  const backRef = useRef<HTMLButtonElement>(null);
  const firstEligibleProposalId = workLayer?.model.batchProposals?.find(
    (proposal) => proposal.eligible,
  )?.id;

  useLayoutEffect(() => {
    const firstProposal =
      firstEligibleProposalId == null
        ? null
        : document.getElementById(
            "work-layer-batch-proposal-" + firstEligibleProposalId,
          );
    (firstProposal ?? backRef.current)?.focus({ preventScroll: true });
  }, [firstEligibleProposalId]);

  if (workLayer == null) return null;

  const {
    model,
    navigation,
    back,
    close,
    openChangeReview,
    openInspect,
    resolvePreview,
    selectFinding,
  } = workLayer;
  const proposals = model.batchProposals ?? [];
  const finding =
    model.attention.find(
      (candidate) => candidate.id === navigation.selectedFindingId,
    ) ?? model.attention[0];
  const eligibleIds = proposals
    .filter((proposal) => proposal.eligible)
    .map((proposal) => proposal.id);
  const selected = selectedIds ?? eligibleIds;

  const toggleProposal = (proposalId: string) => {
    if (!eligibleIds.includes(proposalId)) return;
    setSelectedIds((current) => {
      const base = current ?? eligibleIds;
      return base.includes(proposalId)
        ? base.filter((id) => id !== proposalId)
        : [...base, proposalId];
    });
  };

  return (
    <section
      role="dialog"
      aria-label={t("workLayer.batch.aria", "Batch Review")}
      aria-modal="true"
      className="absolute inset-0 z-50 flex flex-col bg-background/95 p-3 text-foreground backdrop-blur-sm"
    >
      <header className="flex h-10 items-center rounded-t-sm border border-foreground/30 bg-foreground px-3 text-background">
        <button
          ref={backRef}
          type="button"
          onClick={back}
          aria-label={t("workLayer.back", "一段戻る")}
          className="rounded-sm p-1 hover:bg-background/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <span className="ml-2 font-mono text-[9px] tracking-[0.16em]">
          BATCH REVIEW
        </span>
        <span className="ml-2 rounded-sm border border-background/40 px-1.5 py-0.5 font-mono text-[8px] tracking-[0.1em] opacity-70">
          UI PREVIEW
        </span>
        <button
          type="button"
          onClick={close}
          aria-label={t("common.close", "閉じる")}
          className="ml-auto rounded-sm p-1 hover:bg-background/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto border-x border-foreground/30 p-4">
        <div className="mx-auto grid max-w-7xl grid-cols-[minmax(10rem,0.55fr)_minmax(0,2fr)_minmax(15rem,0.8fr)] items-start gap-3">
          <ProjectionWorkGraph
            findings={model.attention}
            selectedFindingId={finding?.id ?? ""}
          />
          <div>
            <p className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
              SAFE PROPOSALS · DETERMINISTIC PREVIEW SET
            </p>
            <h2 className="mt-2 text-base font-semibold">
              {t("workLayer.batch.heading", "安全なProposalを一括確認")}
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t(
                "workLayer.batch.note",
                "押下状態で対象を選びます。チェックボックスはAuthor Task専用です。この承認はまだ保存されません。",
              )}
            </p>
            <p className="mt-3 rounded-sm border border-dashed border-border p-3 text-[11px] leading-relaxed text-muted-foreground">
              {t(
                "workLayer.batch.criteria",
                "SAFEは新規追加のみ・既存構造と矛盾なし・Evidence anchored・重複候補なしのすべてを満たすProposalです。満たさないものは個別判断へ残します。",
              )}
            </p>

            <BatchProposalList
              proposals={proposals}
              selectedIds={selected}
              onToggle={toggleProposal}
            />
          </div>
          <BatchImpactRail onInspect={openInspect} />
        </div>
      </div>

      <BatchReviewFooter
        selectedCount={selected.length}
        onIndividualReview={() => {
          const individualFinding =
            model.attention.find(
              (finding) => finding.kind === "source-missing",
            ) ?? model.attention[0];
          if (individualFinding != null) selectFinding(individualFinding.id);
          openChangeReview();
        }}
        onPreview={() =>
          resolvePreview(
            finding?.id ?? "batch-preview",
            `batch:${selected.join(",")}`,
            t(
              "workLayer.batch.decision",
              "{{count}}件のSafe Proposalを一括承認（UI Preview）",
              { count: selected.length },
            ),
          )
        }
      />
      {finding != null && (
        <ProjectionPipeline finding={finding} activeLabel="BATCH REVIEW" />
      )}
    </section>
  );
}
