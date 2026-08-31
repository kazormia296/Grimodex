import { ArrowLeft, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ChangeReviewActions } from "./ChangeReviewActions";
import { ChangeReviewDiff } from "./ChangeReviewDiff";
import { ChangeReviewRail } from "./ChangeReviewRail";
import { ProjectionPipeline } from "./ProjectionPipeline";
import { ProjectionWorkGraph } from "./ProjectionWorkGraph";
import { useWorkLayer } from "./WorkLayerContext";
import { useWorkLayerInitialFocus } from "./useWorkLayerInitialFocus";

export function ChangeReview() {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  const backRef = useWorkLayerInitialFocus<HTMLButtonElement>();

  if (workLayer == null) return null;

  const { model, navigation, back, close, openInspect, resolvePreview } =
    workLayer;
  const finding =
    model.attention.find(
      (candidate) => candidate.id === navigation.selectedFindingId,
    ) ?? model.attention[0];
  if (finding == null) return null;

  return (
    <section
      role="dialog"
      aria-label={t("workLayer.review.aria", "Change Review")}
      aria-modal="true"
      className="absolute inset-0 z-50 flex flex-col bg-background p-3 text-foreground"
    >
      <header className="flex h-10 shrink-0 items-center rounded-t-sm border border-foreground/30 bg-foreground px-3 text-background">
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
          CHANGE REVIEW
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

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(10rem,0.55fr)_minmax(0,2fr)_minmax(15rem,0.72fr)] gap-3 overflow-auto border-x border-foreground/30 p-3">
        <ProjectionWorkGraph
          findings={model.attention}
          selectedFindingId={finding.id}
        />
        <article className="min-w-0 rounded-sm border border-foreground/30 p-4">
          <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
            {t("workLayer.review.target", "対象 · Chronicle Event「脱獄」")}
          </div>
          <h2 className="mt-2 text-base font-semibold">
            {t(
              "workLayer.review.heading",
              "Change Review — Chronicle Event「脱獄」 V1→V2",
            )}
          </h2>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {finding.title}
          </p>
          <p className="mt-3 rounded-sm border border-dashed border-foreground/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "workLayer.review.proposalNotice",
              "Scene 12の再解釈により、承認済みの内容と異なるProposalが生成されました。適用するまでStory Bibleは書き換えられません。",
            )}
          </p>
          <ChangeReviewDiff />
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 font-mono text-[8px] tracking-[0.08em]">
            <span>
              {t("workLayer.review.states.review", "REVIEW ACCEPTED · V1")}
            </span>
            <span>
              {t(
                "workLayer.review.states.freshness",
                "FRESHNESS SOURCE-MISSING",
              )}
            </span>
            <span>
              {t(
                "workLayer.review.states.projection",
                "PROJECTION APPLIED · V1",
              )}
            </span>
          </div>
        </article>

        <ChangeReviewRail onInspect={openInspect} />
      </div>

      <ChangeReviewActions
        findingId={finding.id}
        onPreviewDecision={resolvePreview}
      />
      <ProjectionPipeline finding={finding} activeLabel="CHANGE REVIEW" />
    </section>
  );
}
