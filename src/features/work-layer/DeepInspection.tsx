import { ArrowLeft, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useWorkLayer } from "./WorkLayerContext";
import { useWorkLayerInitialFocus } from "./useWorkLayerInitialFocus";

export function DeepInspection() {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  const backRef = useWorkLayerInitialFocus<HTMLButtonElement>();
  if (workLayer == null) return null;

  const { model, navigation, back, close } = workLayer;
  const finding =
    model.attention.find(
      (candidate) => candidate.id === navigation.selectedFindingId,
    ) ?? model.attention[0];
  if (finding == null) return null;

  return (
    <section
      role="dialog"
      aria-label={t("workLayer.inspect.aria", "Deep Inspection")}
      aria-modal="true"
      className="absolute inset-0 z-50 flex flex-col bg-background p-4 text-foreground"
    >
      <header className="flex h-10 items-center border-b border-foreground/30">
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
          DEEP INSPECTION · NIR / EDGE / RUN
        </span>
        <span className="ml-2 rounded-sm border border-foreground/30 px-1.5 py-0.5 font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
          READ ONLY
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

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(22rem,1.4fr)_minmax(18rem,1fr)] gap-3 pt-3">
        <article className="min-h-0 overflow-auto rounded-sm border border-foreground/30 p-5">
          <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
            MATERIAL CHAIN
          </div>
          <h2 className="mt-2 text-base font-semibold">{finding.title}</h2>
          <ol className="mt-5 space-y-0">
            {finding.materialChain.map((step, index) => (
              <li key={step} className="grid grid-cols-[1.5rem_1fr] gap-3">
                <div className="flex flex-col items-center">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-foreground/40 font-mono text-[8px]">
                    {index + 1}
                  </span>
                  {index < finding.materialChain.length - 1 && (
                    <span className="min-h-6 w-px flex-1 bg-foreground/30" />
                  )}
                </div>
                <div className="pb-4 pt-0.5 text-xs">{step}</div>
              </li>
            ))}
          </ol>
        </article>

        <aside className="min-h-0 overflow-auto rounded-sm border border-foreground/30 p-5">
          <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
            RUN / TASK / ATTEMPT
          </div>
          <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-3 text-xs">
            <dt className="font-mono text-[9px] text-muted-foreground">RUN</dt>
            <dd>{finding.systemWork.runId}</dd>
            <dt className="font-mono text-[9px] text-muted-foreground">TASK</dt>
            <dd>{finding.systemWork.taskLabel}</dd>
            <dt className="font-mono text-[9px] text-muted-foreground">
              ATTEMPT
            </dt>
            <dd>{finding.systemWork.attemptLabel}</dd>
            <dt className="font-mono text-[9px] text-muted-foreground">
              AUTHORITY
            </dt>
            <dd>{finding.systemWork.authority}</dd>
            <dt className="font-mono text-[9px] text-muted-foreground">
              EPOCH
            </dt>
            <dd>{finding.systemWork.epoch}</dd>
          </dl>
          <div className="mt-6 border-t border-border pt-4">
            <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
              INDEPENDENT STATES
            </div>
            <div className="mt-3 space-y-2 text-xs">
              <div className="flex">
                <span>REVIEW</span>
                <span className="ml-auto">{finding.states.review}</span>
              </div>
              <div className="flex">
                <span>FRESHNESS</span>
                <span className="ml-auto">{finding.states.freshness}</span>
              </div>
              <div className="flex">
                <span>PROJECTION</span>
                <span className="ml-auto">{finding.states.projection}</span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
