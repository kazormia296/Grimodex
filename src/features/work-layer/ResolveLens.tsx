import { ArrowLeft, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ContextPortal } from "./ContextPortal";
import { FindingCandidateList } from "./FindingCandidateList";
import { ResolveLensAnnotations } from "./ResolveLensAnnotations";
import { ResolveLensDetails } from "./ResolveLensDetails";
import { ResolveLensFooter } from "./ResolveLensFooter";
import { useWorkLayer } from "./WorkLayerContext";
import { useWorkLayerInitialFocus } from "./useWorkLayerInitialFocus";
import { withNewPersonCandidate } from "./workLayerCandidateChoices";

export function ResolveLens() {
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  const backRef = useWorkLayerInitialFocus<HTMLButtonElement>();
  if (workLayer == null) return null;

  const {
    model,
    navigation,
    back,
    close,
    openChangeReview,
    openInspect,
    openPortal,
    openProjection,
    resolvePreview,
    selectFinding,
  } = workLayer;
  const findingIndex = Math.max(
    0,
    model.attention.findIndex(
      (candidate) => candidate.id === navigation.selectedFindingId,
    ),
  );
  const finding = model.attention[findingIndex];
  if (finding == null) return null;
  const candidates = withNewPersonCandidate(
    finding.candidates,
    t("workLayer.lens.createPerson", "新しい人物として作成"),
  );
  const selectedCandidate =
    candidates.find((candidate) => candidate.id === candidateId) ??
    candidates[0];
  const nextFinding =
    model.attention.length > 1
      ? model.attention[(findingIndex + 1) % model.attention.length]
      : undefined;
  const portalOpen = navigation.mode === "portal";
  const anchorLabel =
    finding.source.excerpt == null
      ? null
      : (finding.title.match(/[『「](.+?)[』」]/)?.[1] ?? null);

  const selectNextFinding = () => {
    if (nextFinding == null) return;
    setCandidateId(null);
    setActionNote(null);
    selectFinding(nextFinding.id);
    if (nextFinding.kind === "source-missing") {
      openProjection();
      openChangeReview();
    }
  };

  return (
    <div
      data-work-layer-frame
      role="dialog"
      aria-label={t("workLayer.lens.aria", "Resolve Lens")}
      aria-modal="false"
      className="pointer-events-none absolute inset-2 z-40 rounded-sm border border-foreground/60"
    >
      <ResolveLensAnnotations
        attentionCount={model.attention.length}
        anchorLabel={anchorLabel}
        candidateCount={finding.candidates.length}
      />
      <section className="pointer-events-auto absolute bottom-3 right-3 top-3 flex w-[min(30rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-sm border border-foreground/30 bg-background text-foreground shadow-2xl">
        <header className="flex items-center border-b border-foreground/30 px-3 py-2">
          <button
            ref={backRef}
            type="button"
            onClick={back}
            aria-label={t("workLayer.back", "一段戻る")}
            className="rounded-sm p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <span className="ml-2 font-mono text-[9px] tracking-[0.16em]">
            RESOLVE LENS
          </span>
          <span className="ml-2 rounded-sm border border-foreground/30 px-1.5 py-0.5 font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
            UI PREVIEW
          </span>
          <button
            type="button"
            onClick={close}
            aria-label={t("common.close", "閉じる")}
            className="ml-auto rounded-sm p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
            {finding.groupLabel} · {finding.kind.toUpperCase()}
          </div>
          <h2 className="mt-1 text-base font-semibold">{finding.title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {finding.summary}
          </p>

          <ResolveLensDetails finding={finding} />

          {finding.candidates.length > 0 && (
            <FindingCandidateList
              candidates={candidates}
              findingId={finding.id}
              selectedCandidateId={selectedCandidate?.id ?? ""}
              onSelect={setCandidateId}
            />
          )}

          {portalOpen && (
            <ContextPortal
              selectedCandidateId={selectedCandidate?.id ?? null}
              onSelectCandidate={setCandidateId}
            />
          )}

          <div className="mt-4 grid grid-cols-3 divide-x divide-border border-y border-border py-2 text-center">
            {(
              [
                ["REVIEW", finding.states.review],
                ["FRESHNESS", finding.states.freshness],
                ["PROJECTION", finding.states.projection],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="px-1">
                <div className="font-mono text-[8px] tracking-[0.12em] text-muted-foreground">
                  {label}
                </div>
                <div className="mt-1 truncate text-[10px] font-medium">
                  {value}
                </div>
              </div>
            ))}
          </div>
        </div>

        <ResolveLensFooter
          finding={finding}
          selectedCandidate={selectedCandidate}
          nextFinding={nextFinding}
          actionNote={actionNote}
          portalAvailable={
            !portalOpen &&
            finding.candidates.length > 0 &&
            model.codexPanelAvailable === false
          }
          onBind={() => {
            if (selectedCandidate == null) return;
            resolvePreview(
              finding.id,
              selectedCandidate.id,
              t("workLayer.lens.bindingDecision", "{{candidate}}へ Binding", {
                candidate: selectedCandidate.label,
              }),
            );
          }}
          onHold={() =>
            setActionNote(
              t(
                "workLayer.lens.holdPreview",
                "保留をプレビューしました。保存されていません。",
              ),
            )
          }
          onExcludePair={() =>
            setActionNote(
              t(
                "workLayer.lens.excludePairPreview",
                "候補ペアの除外をプレビューしました。保存されていません。",
              ),
            )
          }
          onNext={selectNextFinding}
          onOpenPortal={openPortal}
          onInspect={openInspect}
        />
      </section>
    </div>
  );
}
