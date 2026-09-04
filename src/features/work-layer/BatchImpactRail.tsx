import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

interface BatchImpactRailProps {
  readonly onInspect: () => void;
}

export function BatchImpactRail({ onInspect }: BatchImpactRailProps) {
  const { t } = useTranslation();
  const impacts = [
    t(
      "workLayer.batch.impacts.chronicle",
      "Chronicle · Event +2 / State +1 / Relation +1",
    ),
    t("workLayer.batch.impacts.timeline", "Timeline 再構築 · 1"),
    t("workLayer.batch.impacts.scenes", "Related Scenes 再評価 · 4件"),
  ];

  return (
    <aside
      role="region"
      aria-label={t("workLayer.batch.impact", "承認した場合の影響")}
      className="rounded-sm border border-foreground/30 p-4"
    >
      <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
        {t("workLayer.batch.impact", "承認した場合の影響")}
      </div>
      <ul className="mt-3 space-y-2 text-xs">
        {impacts.map((impact) => (
          <li key={impact} className="flex gap-2">
            <span
              aria-hidden="true"
              className="mt-1 h-1.5 w-1.5 shrink-0 border border-foreground"
            />
            <span>{impact}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t border-border pt-3 font-mono text-[8px] leading-relaxed tracking-[0.08em] text-muted-foreground">
        {t(
          "workLayer.batch.impactNote",
          "一括承認は1 Decisionとして記録され、個別に取り消せます。要個別判断は選択されません。",
        )}
      </p>
      <button
        id="work-layer-batch-inspect"
        type="button"
        aria-label={t(
          "workLayer.batch.openInspection",
          "Deep Inspectionを開く",
        )}
        onClick={onInspect}
        className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-sm border border-foreground/30 px-3 py-2 font-mono text-[9px] tracking-[0.1em] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search className="h-3 w-3" /> DEEP INSPECTION
      </button>
    </aside>
  );
}
