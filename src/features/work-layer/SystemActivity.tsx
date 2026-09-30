import { ArrowLeft, Circle, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import { useWorkLayer } from "./WorkLayerContext";
import { useWorkLayerInitialFocus } from "./useWorkLayerInitialFocus";

export function SystemActivity() {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  const backRef = useWorkLayerInitialFocus<HTMLButtonElement>();
  if (workLayer == null) return null;

  const { model, back, close } = workLayer;
  const activities = model.system.activities ?? [];

  return (
    <section
      role="dialog"
      aria-label={t("workLayer.system.activityAria", "System Activity")}
      aria-modal="false"
      className="absolute left-1/2 top-2 z-40 flex max-h-[min(32rem,calc(100%-1rem))] w-[min(21rem,calc(100%-2rem))] translate-x-14 flex-col overflow-hidden rounded-sm border border-border bg-background text-foreground shadow-2xl"
    >
      <header className="flex h-10 shrink-0 items-center border-b border-border px-3">
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
          SYSTEM ACTIVITY
        </span>
        <span className="ml-2 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
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
        <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
              SYS · {model.system.state.toUpperCase()}
            </div>
            <h2 className="mt-1 text-base font-semibold">
              {model.system.label}
            </h2>
          </div>
          <span className="rounded-sm border border-border bg-muted/30 px-2 py-1 font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
            READ ONLY
          </span>
        </div>

        {activities.length === 0 ? (
          <p className="mt-4 rounded-sm border border-dashed border-border p-4 text-sm text-muted-foreground">
            {t(
              "workLayer.system.activityEmpty",
              "表示できるSystem activityの明細はまだありません。",
            )}
          </p>
        ) : (
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
                      activity.state === "completed" && "text-muted-foreground",
                      activity.state === "queued" && "text-muted-foreground/60",
                      activity.state === "running" && "text-foreground",
                    )}
                  />
                  <span className="text-sm font-medium">{activity.label}</span>
                  <span className="ml-auto font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
                    {activity.state.toUpperCase()}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {activity.detail}
                </p>
              </li>
            ))}
          </ol>
        )}

        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          {t(
            "workLayer.system.activityReadOnly",
            "SYSは実行状況の読み取り専用プレビューです。FindingやTaskをチェック操作へ変換しません。",
          )}
        </p>
      </div>
    </section>
  );
}
