import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import { DisposedAccordion } from "./DisposedAccordion";
import { useWorkLayer } from "./WorkLayerContext";
import { deriveAllWork } from "./workLedgerItems";

export function AttentionTrayBody() {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  if (workLayer == null) return null;

  const {
    model,
    navigation,
    back,
    openChangeReview,
    openDisposed,
    openFinding,
    openFocus,
    openProjection,
    selectFinding,
    switchFocusPreview,
  } = workLayer;
  const isEmpty = model.attention.length === 0;
  const disposedExpanded = navigation.mode === "tray-disposed";
  const allWork = deriveAllWork(model);
  const laterTargets =
    model.focus?.later ??
    allWork
      .filter((item) => item.status === "waiting")
      .map((item) => ({ id: item.id, title: item.title }));
  const previousCompleted =
    model.focus == null
      ? allWork.find((item) => item.status === "completed")
      : null;
  const openAttentionItem = (findingId: string, kind: string) => {
    if (kind !== "source-missing") {
      openFinding(findingId);
      return;
    }
    selectFinding(findingId);
    openProjection();
    openChangeReview();
  };

  return (
    <div className="min-h-0 overflow-auto">
      {!isEmpty && (
        <div className="bg-foreground px-3 py-2 text-background">
          <div className="flex items-center font-mono text-[9px] tracking-[0.16em]">
            ATTENTION
            <span className="ml-auto text-xs font-bold tabular-nums">
              {model.attention.length}
            </span>
          </div>
          <p className="mt-1 text-[11px] opacity-70">
            {t(
              "workLayer.tray.attentionNote",
              "作者の判断で解消します。チェックで完了にはしません。",
            )}
          </p>
        </div>
      )}

      {model.attention.map((finding) => (
        <button
          id={`work-layer-finding-${finding.id}`}
          key={finding.id}
          type="button"
          aria-label={t(
            finding.kind === "source-missing"
              ? "workLayer.tray.openFindingReview"
              : "workLayer.tray.openFinding",
            finding.kind === "source-missing"
              ? "{{title}}をChange Reviewで開く"
              : "{{title}}を開く",
            { title: finding.title },
          )}
          onClick={() => openAttentionItem(finding.id, finding.kind)}
          className="flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <span className="mt-1 h-2 w-2 shrink-0 bg-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block font-mono text-[8px] tracking-[0.13em] text-muted-foreground">
              {finding.groupLabel} · {finding.kind.toUpperCase()}
            </span>
            <span className="mt-1 block text-xs font-medium">
              {finding.title}
            </span>
            <span className="mt-1 block truncate text-[11px] text-muted-foreground">
              {finding.summary}
            </span>
          </span>
          <ChevronRight className="mt-3 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      ))}

      {model.attention.length > 1 && (
        <button
          id="work-layer-open-projection"
          type="button"
          aria-label={t(
            "workLayer.tray.openProjection",
            "{{count}}件をResolve Projectionで開く",
            { count: model.attention.length },
          )}
          onClick={openProjection}
          className="flex w-full items-center px-4 py-3 font-mono text-[9px] tracking-[0.12em] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {t(
            "workLayer.tray.openProjectionLabel",
            "{{count}}件をまとめて RESOLVE で開く",
            { count: model.attention.length },
          )}
          <ChevronRight className="ml-auto h-3.5 w-3.5" />
        </button>
      )}

      <button
        id="work-layer-switch-focus"
        type="button"
        onClick={openFocus}
        aria-label={t("workLayer.tray.expandFocus", "Focusを展開")}
        className={cn(
          "flex w-full items-center gap-2 border-t border-border px-4 py-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          isEmpty && "pr-12",
        )}
      >
        <span className="font-mono text-[9px] tracking-[0.16em] text-muted-foreground">
          NOW
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {model.focus?.title ?? t("workLayer.tray.noFocus", "Focus なし")}
        </span>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {previousCompleted != null && (
        <div className="flex items-center gap-2 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span aria-hidden="true">✓</span>
          <span className="line-through">{previousCompleted.title}</span>
          <span className="ml-auto font-mono text-[8px] tracking-[0.08em]">
            {previousCompleted.updatedLabel}
          </span>
        </div>
      )}

      <div className="border-t border-border px-4 py-3">
        <div className="font-mono text-[9px] tracking-[0.16em] text-muted-foreground">
          LATER
        </div>
        <div className="mt-1 space-y-1">
          {laterTargets.map((target) => (
            <button
              key={target.id}
              type="button"
              onClick={() => switchFocusPreview(target.id)}
              aria-label={t(
                "workLayer.tray.switchFocusTarget",
                "{{title}}へFocusを切り替える",
                { title: target.title },
              )}
              className="flex w-full items-center rounded-sm px-1 py-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="mr-2 h-1.5 w-1.5 border border-foreground/50" />
              <span className="min-w-0 flex-1 truncate">{target.title}</span>
              <span className="ml-3 shrink-0 text-[10px] text-muted-foreground">
                {t("workLayer.tray.switchFocus", "Focusへ切り替える")}
              </span>
            </button>
          ))}
        </div>
      </div>

      <DisposedAccordion
        expanded={disposedExpanded}
        onToggle={disposedExpanded ? back : openDisposed}
      />
    </div>
  );
}
