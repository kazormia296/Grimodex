import { useEffect, useMemo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SlotPanelProps } from "@/features/layout/layoutTypes";
import { PanelHeader } from "@/features/layout/PanelHeader";
import { Download } from "lucide-react";
import { useEditorStore } from "@/features/editor/editorStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { computeAttributionStats } from "./attributionStats";
import { useAttributionStore } from "./attributionStore";
import { ExportAgentTraceButton } from "./ExportAgentTraceButton";
import { AttributionProjectView } from "./AttributionProjectView";
import { BreakdownBar } from "./BreakdownBar";
import { ATTRIBUTION_COLOR_VARS } from "./attributionColors";
import {
  exportAttributionMarkdown,
  exportAttributionCsv,
  downloadTextFile,
} from "./exportReport";
import type { FilterSource } from "./attributionStore";
import { recordMark } from "@/lib/perfLog";
import {
  extractSpansFromDoc,
  resolveProvenance,
  type ProvenanceKind,
  type ResolvedPassage,
} from "./provenance";

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
    <button
      type="button"
      aria-pressed={isActive}
      className={`flex w-full items-center gap-2 text-left text-xs cursor-pointer rounded px-1 py-0.5 transition-colors ${isActive ? "bg-accent" : "hover:bg-accent/50"}`}
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
    </button>
  );
}

export function AttributionReport({ isActive = true }: SlotPanelProps = {}) {
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const editor = useEditorStore((s) => s.editor);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
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

  const [passages, setPassages] = useState<ResolvedPassage[]>([]);
  const [isLoadingPassages, setIsLoadingPassages] = useState(false);

  const aiSpanSignal = useMemo(() => {
    if (scope !== "scene" || !editor || !activeSceneId) return "";
    return extractSpansFromDoc(editor.state.doc, activeSceneId)
      .filter((s) => s.source === "ai")
      .map((s) => `${s.from}:${s.to}:${s.traceId ?? ""}:${s.chatMsgId ?? ""}`)
      .join("|");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, editor, activeSceneId, editor?.state.doc]);

  useEffect(() => {
    // keepalive で hidden の間は provenance 解決 (async DB/trace lookup) を bail。
    // passages はパネル local state なので stale のまま残し、再アクティブ化時に
    // isActive deps 経由で現在シーンを 1 回再解決して catch up する。
    if (!isActive) return;
    if (scope !== "scene" || !editor || !activeSceneId || !aiSpanSignal) {
      setPassages([]);
      setIsLoadingPassages(false);
      return;
    }

    let cancelled = false;
    setIsLoadingPassages(true);
    const timer = setTimeout(() => {
      const spans = extractSpansFromDoc(editor.state.doc, activeSceneId);
      resolveProvenance(spans, (nodeId, from, to) => {
        if (nodeId !== activeSceneId) return "";
        return editor.state.doc.textBetween(from, to, " ", " ");
      })
        .then((next) => {
          if (!cancelled) setPassages(next);
        })
        .catch((err: unknown) => {
          console.warn("resolve provenance failed", err);
          if (!cancelled) setPassages([]);
        })
        .finally(() => {
          if (!cancelled) setIsLoadingPassages(false);
        });
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isActive, scope, editor, activeSceneId, aiSpanSignal]);

  const handleJumpToPassage = useCallback((passage: ResolvedPassage) => {
    useTreeStore.getState().setActiveScene(passage.nodeId);
    setTimeout(() => {
      const ed = useEditorStore.getState().editor;
      ed?.chain()
        .focus()
        .setTextSelection({
          from: passage.from,
          to: passage.to,
        })
        .run();
    }, 0);
  }, []);

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
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="attribution-report"
    >
      <PanelHeader
        panelId="attribution"
        actions={(["scene", "project"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setScope(s)}
            className={`rounded px-2 py-0.5 text-xs transition-colors ${scope === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
          >
            {s === "scene" ? t("attribution.scene") : t("attribution.project")}
          </button>
        ))}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
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
              color={ATTRIBUTION_COLOR_VARS.human}
              source="human"
              activeFilter={filterSource}
              onFilter={setFilterSource}
            />
            <StatBar
              label={t("attribution.ai")}
              count={stats.ai}
              total={stats.total}
              color={ATTRIBUTION_COLOR_VARS.ai}
              source="ai"
              activeFilter={filterSource}
              onFilter={setFilterSource}
            />
            <StatBar
              label={t("attribution.unknown")}
              count={stats.unknown}
              total={stats.total}
              color={ATTRIBUTION_COLOR_VARS.unknown}
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
                    <div
                      key={model}
                      className="flex items-center gap-2 text-xs"
                    >
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

            {(isLoadingPassages || passages.length > 0) && (
              <div className="mt-1 border-t border-border pt-2">
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  {t("attribution.aiUsageLocations")}
                </p>
                {isLoadingPassages ? (
                  <p className="text-xs text-muted-foreground">
                    {t("common.loading")}
                  </p>
                ) : (
                  <div className="flex max-h-56 flex-col gap-1 overflow-auto">
                    {passages.map((passage) => (
                      <PassageRow
                        key={passage.id}
                        passage={passage}
                        onJump={handleJumpToPassage}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between pt-1 border-t border-border">
              <div className="flex gap-1">
                <ExportAgentTraceButton />
                <button
                  type="button"
                  onClick={handleExportMd}
                  className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent"
                  title={t("attribution.exportMarkdownTitle")}
                >
                  <Download className="h-3 w-3" /> MD
                </button>
                <button
                  type="button"
                  onClick={handleExportCsv}
                  className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent"
                  title={t("attribution.exportCsvTitle")}
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
    </div>
  );
  recordMark(
    "attributionReport.render",
    performance.now() - __perfStart,
    __perfStart,
  );
  return __renderResult;
}

function provenanceLabel(
  kind: ProvenanceKind,
  t: (key: string) => string,
): string {
  switch (kind) {
    case "chat":
      return t("attribution.provenanceChat");
    case "inline-ai":
      return "slash";
    case "beat":
      return "Beat";
    case "orphan-chat":
      return t("attribution.provenanceOrphanChat");
    case "unknown":
      return t("attribution.provenanceUnknown");
  }
}

function PassageRow({
  passage,
  onJump,
}: {
  passage: ResolvedPassage;
  onJump: (passage: ResolvedPassage) => void;
}) {
  const { t } = useTranslation();
  const provenance = passage.provenance;
  const detail =
    provenance.kind === "chat"
      ? (provenance.precedingUserPrompt ??
        provenance.chatMessage?.content ??
        "")
      : provenance.kind === "inline-ai" || provenance.kind === "beat"
        ? [provenance.commandId, provenance.instruction]
            .filter(Boolean)
            .join(": ")
        : provenance.kind === "orphan-chat"
          ? t("attribution.detailOrphanChat")
          : t("attribution.detailLegacyContent");

  return (
    <button
      type="button"
      onClick={() => onJump(passage)}
      className="rounded border border-border px-2 py-1 text-left text-xs hover:bg-accent"
    >
      <div className="flex items-center gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {provenanceLabel(provenance.kind, t)}
        </span>
        {passage.model && (
          <span className="truncate text-[10px] text-muted-foreground">
            {passage.model}
          </span>
        )}
      </div>
      <p className="mt-1 line-clamp-2 text-foreground">{passage.excerpt}</p>
      {detail && (
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {detail}
        </p>
      )}
    </button>
  );
}
