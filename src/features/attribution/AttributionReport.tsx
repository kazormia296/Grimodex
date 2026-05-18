import { useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { useEditorStore } from "@/features/editor/editorStore";
import { computeAttributionStats } from "./attributionStats";
import { useAttributionStore } from "./attributionStore";
import { ExportAgentTraceButton } from "./ExportAgentTraceButton";
import { AttributionProjectView } from "./AttributionProjectView";
import { BreakdownBar } from "./BreakdownBar";
import {
  exportAttributionMarkdown,
  exportAttributionCsv,
  downloadTextFile,
} from "./exportReport";
import type { FilterSource } from "./attributionStore";
import { recordMark } from "@/lib/perfLog";

const UNKNOWN_MODEL_KEY = "__unknown_model__";

interface StatBarProps {
  label: string;
  count: number;
  total: number;
  color: string;
  source: FilterSource;
  activeFilter: FilterSource;
  onFilter: (source: FilterSource) => void;
}

function StatBar({
  label,
  count,
  total,
  color,
  source,
  activeFilter,
  onFilter,
}: StatBarProps) {
  const { t } = useTranslation();
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const isActive = activeFilter === source;
  return (
    <div
      className={`flex items-center gap-2 text-xs cursor-pointer rounded px-1 py-0.5 transition-colors ${isActive ? "bg-accent" : "hover:bg-accent/50"}`}
      onClick={() => onFilter(isActive ? null : source)}
      title={
        isActive
          ? t("attribution.clearFilterTitle")
          : t("attribution.filterOnlyTitle", { label })
      }
    >
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex-1 h-3 rounded bg-muted overflow-hidden">
        <div
          className="h-full rounded"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="w-16 text-right tabular-nums text-muted-foreground">
        {t("attribution.charCount", { count, pct })}
      </span>
    </div>
  );
}

export function AttributionReport() {
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const editor = useEditorStore((s) => s.editor);
  const scope = useAttributionStore((s) => s.scope);
  const filterSource = useAttributionStore((s) => s.filterSource);
  const setScope = useAttributionStore((s) => s.setScope);
  const setFilterSource = useAttributionStore((s) => s.setFilterSource);

  const stats = useMemo(() => {
    if (scope !== "scene" || !editor) return null;
    return computeAttributionStats(editor.state.doc);
    // editor は安定参照だが TipTap の state.doc は遷移ごとに変わる。
    // doc の変化で再計算したいので明示的に依存に含める。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, editor, editor?.state.doc]);

  const handleExportMd = useCallback(() => {
    if (!stats) return;
    const md = exportAttributionMarkdown(stats, "Scene Attribution");
    downloadTextFile(md, "attribution-report.md", "text/markdown");
  }, [stats]);

  const handleExportCsv = useCallback(() => {
    if (!stats) return;
    const csv = exportAttributionCsv(stats, "Scene Attribution");
    downloadTextFile(csv, "attribution-report.csv", "text/csv");
  }, [stats]);

  const __renderResult = (
    <div className="flex flex-col gap-3 p-3" data-testid="attribution-report">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t("attribution.report")}</h3>
        <div className="flex gap-1">
          {(["scene", "project"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`rounded px-2 py-0.5 text-xs transition-colors ${scope === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
            >
              {s === "scene"
                ? t("attribution.scene")
                : t("attribution.project")}
            </button>
          ))}
        </div>
      </div>

      {scope === "project" ? (
        <AttributionProjectView />
      ) : !stats || stats.total === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("attribution.noText")}
        </p>
      ) : (
        <>
          {filterSource && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span>{t("attribution.filtering")}</span>
              <button
                type="button"
                onClick={() => setFilterSource(null)}
                className="text-primary underline"
              >
                {t("attribution.clearFilter")}
              </button>
            </div>
          )}
          <StatBar
            label={t("attribution.human")}
            count={stats.human + stats.unmarked}
            total={stats.total}
            color="oklch(0.65 0.10 220)"
            source="human"
            activeFilter={filterSource}
            onFilter={setFilterSource}
          />
          <StatBar
            label={t("attribution.ai")}
            count={stats.ai}
            total={stats.total}
            color="oklch(0.65 0.18 250)"
            source="ai"
            activeFilter={filterSource}
            onFilter={setFilterSource}
          />
          <StatBar
            label={t("attribution.unknown")}
            count={stats.unknown}
            total={stats.total}
            color="oklch(0.65 0.05 0)"
            source="unknown"
            activeFilter={filterSource}
            onFilter={setFilterSource}
          />

          <BreakdownBar
            human={stats.human + stats.unmarked}
            ai={stats.ai}
            unknown={stats.unknown}
            total={stats.total}
          />

          {Object.keys(stats.modelBreakdown).length > 0 && (
            <div className="mt-1">
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {t("attribution.byModel")}
              </p>
              {Object.entries(stats.modelBreakdown).map(([model, count]) => {
                const pct =
                  stats.ai > 0 ? Math.round((count / stats.ai) * 100) : 0;
                const label =
                  model === UNKNOWN_MODEL_KEY
                    ? t("attribution.unknownModel")
                    : model;
                return (
                  <div key={model} className="flex items-center gap-2 text-xs">
                    <span
                      className="flex-1 truncate text-muted-foreground"
                      title={label}
                    >
                      {label}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {t("attribution.charCount", { count, pct })}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center justify-between pt-1 border-t border-border">
            <div className="flex gap-1">
              <ExportAgentTraceButton />
              <button
                type="button"
                onClick={handleExportMd}
                className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent"
                title="Markdown export"
              >
                <Download className="h-3 w-3" /> MD
              </button>
              <button
                type="button"
                onClick={handleExportCsv}
                className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent"
                title="CSV export"
              >
                <Download className="h-3 w-3" /> CSV
              </button>
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">
              {t("attribution.total", { count: stats.total })}
            </span>
          </div>
        </>
      )}
    </div>
  );
  recordMark(
    "attributionReport.render",
    performance.now() - __perfStart,
    __perfStart,
  );
  return __renderResult;
}
