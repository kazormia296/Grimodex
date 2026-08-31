import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { WorkLayerDisposition } from "./types";
import { useWorkLayer } from "./WorkLayerContext";

const LABELS: Record<WorkLayerDisposition, string> = {
  snoozed: "SNOOZE",
  held: "HOLD",
  dismissed: "DISMISSED",
  legacy: "LEGACY",
};

const DETAIL_KEYS: Record<WorkLayerDisposition, string> = {
  snoozed: "workLayer.disposed.snoozedDetail",
  held: "workLayer.disposed.heldDetail",
  dismissed: "workLayer.disposed.dismissedDetail",
  legacy: "workLayer.disposed.legacyDetail",
};

const DETAIL_FALLBACKS: Record<WorkLayerDisposition, string> = {
  snoozed: "再浮上まで保留",
  held: "作者判断まで保持",
  dismissed: "同一問題は再通知しない",
  legacy: "推測で再割当しない",
};

interface DisposedAccordionProps {
  readonly expanded: boolean;
  readonly onToggle: () => void;
}

export function DisposedAccordion({
  expanded,
  onToggle,
}: DisposedAccordionProps) {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  if (workLayer == null || workLayer.model.disposedAttention.length === 0) {
    return null;
  }

  const items = workLayer.model.disposedAttention;
  const panelId = "work-layer-disposed-panel";

  return (
    <div className="border-t border-border">
      <button
        id="work-layer-open-disposed"
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={t(
          expanded
            ? "workLayer.disposed.closeAria"
            : "workLayer.disposed.openAria",
          expanded
            ? "処分済みの判断 {{count}}件を閉じる"
            : "処分済みの判断 {{count}}件を開く",
          { count: items.length },
        )}
        className="flex w-full items-center px-4 py-3 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {expanded ? (
          <ChevronDown className="mr-2 h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="mr-2 h-3.5 w-3.5" />
        )}
        {t("workLayer.disposed.open", "処分済み")}
        <span className="ml-2 font-mono text-[8px] tracking-[0.1em]">
          {t("workLayer.disposed.retention", "件数外 · 削除しない")}
        </span>
        <span className="ml-auto font-mono tabular-nums">{items.length}</span>
      </button>

      {expanded && (
        <section
          id={panelId}
          role="region"
          aria-label={t("workLayer.disposed.aria", "処分済みの判断")}
          className="border-t border-dashed border-border px-4 py-3"
        >
          <div className="space-y-1">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-muted-foreground"
              >
                <span className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[8px] tracking-[0.1em]">
                  {LABELS[item.disposition]}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="shrink-0 font-mono text-[8px]">
                  {t(
                    DETAIL_KEYS[item.disposition],
                    DETAIL_FALLBACKS[item.disposition],
                  )}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
            {t(
              "workLayer.disposed.note",
              "Dismiss済みはmaterial basisが変わると新しいFindingとして再浮上します。",
            )}
          </p>
        </section>
      )}
    </div>
  );
}
