import { ArrowLeft, Circle, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import { useWorkLayer } from "./WorkLayerContext";
import { useWorkLayerInitialFocus } from "./useWorkLayerInitialFocus";

export function SystemRunInspection() {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  const backRef = useWorkLayerInitialFocus<HTMLButtonElement>();
  if (workLayer == null) return null;

  const { model, back, close } = workLayer;
  const run = model.attention[0]?.systemWork;
  const activities = model.system.activities ?? [];

  return (
    <section
      role="dialog"
      aria-label={t(
        "workLayer.system.runInspectionAria",
        "System Run Inspection",
      )}
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
          SYSTEM RUN INSPECTION
        </span>
        <span className="ml-2 rounded-sm border border-foreground/30 px-1.5 py-0.5 font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
          READ ONLY · UI PREVIEW
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

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(20rem,1fr)_minmax(18rem,1fr)] gap-3 pt-3">
        <article className="min-h-0 overflow-auto rounded-sm border border-foreground/30 p-5">
          <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
            RUN / TASK / ATTEMPT
          </div>
          <h2 className="mt-2 text-base font-semibold">{model.system.label}</h2>
          <dl className="mt-5 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-3 text-xs">
            <dt className="font-mono text-[9px] text-muted-foreground">RUN</dt>
            <dd>{run?.runId ?? "preview-run"}</dd>
            <dt className="font-mono text-[9px] text-muted-foreground">TASK</dt>
            <dd>{run?.taskLabel ?? model.system.label}</dd>
            <dt className="font-mono text-[9px] text-muted-foreground">
              ATTEMPT
            </dt>
            <dd>{run?.attemptLabel ?? "preview"}</dd>
            <dt className="font-mono text-[9px] text-muted-foreground">
              AUTHORITY
            </dt>
            <dd>{run?.authority ?? "preview only"}</dd>
            <dt className="font-mono text-[9px] text-muted-foreground">
              EPOCH
            </dt>
            <dd>{run?.epoch ?? "—"}</dd>
          </dl>
          <div className="mt-6 border-t border-border pt-4">
            <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
              {t("workLayer.system.blockedReason", "停止理由")}
            </div>
            <p className="mt-2 text-xs leading-relaxed">
              {model.system.blockedReason ??
                t(
                  "workLayer.system.blockedReasonFallback",
                  "停止理由の詳細はまだ提供されていません。",
                )}
            </p>
          </div>
        </article>

        <aside className="min-h-0 overflow-auto rounded-sm border border-foreground/30 p-5">
          <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
            SYSTEM ACTIVITY · READ ONLY
          </div>
          <ol className="mt-4 space-y-2">
            {activities.map((activity) => (
              <li
                key={activity.id}
                className="rounded-sm border border-border bg-card p-3"
              >
                <div className="flex items-center gap-2">
                  <Circle
                    aria-hidden="true"
                    className={cn(
                      "h-2.5 w-2.5 fill-current",
                      activity.state !== "running" && "text-muted-foreground",
                    )}
                  />
                  <span className="text-sm font-medium">{activity.label}</span>
                  <span className="ml-auto font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
                    {activity.state.toUpperCase()}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {activity.detail}
                </p>
              </li>
            ))}
          </ol>
          <p className="mt-4 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
            {t(
              "workLayer.system.runInspectionNote",
              "この画面はfixture由来の読み取り専用UIです。実行・保存・NIR更新は行いません。",
            )}
          </p>
        </aside>
      </div>
    </section>
  );
}
