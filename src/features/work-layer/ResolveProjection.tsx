import { ArrowLeft, Search, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ProjectionCandidateContext } from "./ProjectionCandidateContext";
import { ProjectionDecisionPanel } from "./ProjectionDecisionPanel";
import { ProjectionPipeline } from "./ProjectionPipeline";
import { ProjectionWorkGraph } from "./ProjectionWorkGraph";
import { useWorkLayer } from "./WorkLayerContext";
import { useWorkLayerInitialFocus } from "./useWorkLayerInitialFocus";
import { withNewPersonCandidate } from "./workLayerCandidateChoices";

export function ResolveProjection() {
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(
    null,
  );
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  const backRef = useWorkLayerInitialFocus<HTMLButtonElement>();
  if (workLayer == null) return null;

  const {
    model,
    navigation,
    back,
    close,
    openBatch,
    openChangeReview,
    openInspect,
    selectFinding,
  } = workLayer;
  const selected =
    model.attention.find(
      (finding) => finding.id === navigation.selectedFindingId,
    ) ?? model.attention[0];
  if (selected == null) return null;
  const selectedIndex = model.attention.findIndex(
    (finding) => finding.id === selected.id,
  );
  const nextFinding =
    model.attention.length > 1
      ? model.attention[(selectedIndex + 1) % model.attention.length]
      : undefined;
  const candidates = withNewPersonCandidate(
    selected.candidates,
    t("workLayer.lens.createPerson", "新しい人物として作成"),
  );
  const selectedCandidate =
    candidates.find((candidate) => candidate.id === selectedCandidateId) ??
    candidates[0];

  return (
    <section
      role="dialog"
      aria-label={t("workLayer.projection.aria", "Resolve Projection")}
      aria-modal="true"
      className="absolute inset-0 z-40 flex flex-col bg-background/95 p-3 text-foreground backdrop-blur-sm"
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
          RESOLVE PROJECTION
        </span>
        <span className="ml-2 rounded-sm border border-background/40 px-1.5 py-0.5 font-mono text-[8px] tracking-[0.1em] opacity-70">
          UI PREVIEW
        </span>
        <span className="ml-auto font-mono text-[8px] tracking-[0.12em] opacity-60">
          {t("workLayer.projection.presetUnchanged", "PRESET UNCHANGED")}
        </span>
        <button
          type="button"
          onClick={close}
          aria-label={t("common.close", "閉じる")}
          className="ml-3 rounded-sm p-1 hover:bg-background/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(11rem,0.72fr)_minmax(20rem,2fr)_minmax(13rem,0.9fr)] gap-2 border-x border-foreground/30 p-2">
        <ProjectionWorkGraph
          findings={model.attention}
          selectedFindingId={selected.id}
          onSelect={(findingId) => {
            setSelectedCandidateId(null);
            selectFinding(findingId);
          }}
        />

        <article className="min-h-0 overflow-auto rounded-sm border border-foreground/30 p-5">
          <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
            TARGET · {selected.source.label}
          </div>
          <h2 className="mt-2 text-lg font-semibold">{selected.title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {selected.summary}
          </p>
          <blockquote className="mt-5 border-l-[3px] border-foreground/50 pl-4 text-base leading-loose">
            {selected.source.excerpt ??
              t(
                "workLayer.lens.sourceMissing",
                "現在の本文にAnchorがありません",
              )}
          </blockquote>
          <div className="mt-6 rounded-sm border border-dashed border-foreground/30 p-4">
            <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
              DETERMINISTIC REASON
            </div>
            <p className="mt-2 text-sm">{selected.reason}</p>
          </div>
          <ProjectionDecisionPanel
            key={selected.id}
            finding={selected}
            nextFinding={nextFinding}
            selectedCandidateId={selectedCandidate?.id ?? null}
            onSelectCandidate={setSelectedCandidateId}
            onResolve={workLayer.resolvePreview}
            onNext={() => {
              if (nextFinding == null) return;
              setSelectedCandidateId(null);
              selectFinding(nextFinding.id);
            }}
          />
        </article>

        <aside className="min-h-0 overflow-auto rounded-sm border border-foreground/30 p-4">
          {selectedCandidate != null && (
            <ProjectionCandidateContext candidate={selectedCandidate} />
          )}
          <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
            EVIDENCE / IMPACT
          </div>
          <div className="mt-3 space-y-2 text-xs">
            {selected.impact.map((item) => (
              <div key={item} className="flex gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 border border-foreground" />
                <span>{item}</span>
              </div>
            ))}
          </div>
          <div className="mt-5 space-y-2 border-t border-border pt-4 font-mono text-[8px] tracking-[0.1em]">
            <div>REVIEW · {selected.states.review}</div>
            <div>FRESHNESS · {selected.states.freshness}</div>
            <div>PROJECTION · {selected.states.projection}</div>
          </div>
          {selected.kind === "source-missing" && (
            <button
              id="work-layer-open-change-review"
              type="button"
              aria-label={t("workLayer.review.open", "Change Reviewを開く")}
              onClick={openChangeReview}
              className="mt-5 flex w-full items-center justify-center rounded-sm border border-foreground/30 px-3 py-2 font-mono text-[9px] tracking-[0.1em] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              CHANGE REVIEW
            </button>
          )}
          <button
            id="work-layer-open-batch"
            type="button"
            aria-label={t("workLayer.batch.open", "安全なProposalを一括確認")}
            onClick={openBatch}
            className="mt-2 flex w-full items-center justify-center rounded-sm border border-foreground/30 px-3 py-2 font-mono text-[9px] tracking-[0.1em] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            BATCH SAFE
          </button>
          <button
            id="work-layer-inspect-projection"
            type="button"
            aria-label={t("workLayer.inspect.open", "詳細を検査")}
            onClick={openInspect}
            className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-sm border border-foreground/30 px-3 py-2 font-mono text-[9px] tracking-[0.1em] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Search className="h-3 w-3" /> INSPECT
          </button>
        </aside>
      </div>

      <ProjectionPipeline finding={selected} activeLabel="AUTHOR REVIEW" />
    </section>
  );
}
