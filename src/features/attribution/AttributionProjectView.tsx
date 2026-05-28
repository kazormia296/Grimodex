import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  ChevronDown,
  RefreshCw,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCurrentProjectId } from "@/features/project/projectStore";
import { useAttributionStore } from "./attributionStore";
import { loadProjectAttributionStats } from "./projectStats";
import { BreakdownBar } from "./BreakdownBar";
import type { AttributionStats } from "./attributionStats";
import { buildProjectAuthorshipReport } from "./projectAuthorship";
import {
  exportAuthorshipJson,
  exportAuthorshipHtml,
  downloadTextFile,
} from "./exportReport";
import { Download } from "lucide-react";

type SortColumn = "scene" | "total" | "human" | "ai" | "unknown" | "aiPct";
type SortDir = "asc" | "desc";

interface SceneRow {
  id: string;
  title: string;
  stats: AttributionStats | null;
}

function SortIcon({
  col,
  active,
  dir,
}: {
  col: SortColumn;
  active: SortColumn;
  dir: SortDir;
}) {
  if (col !== active) return <ArrowUpDown className="h-3 w-3 opacity-30" />;
  return dir === "asc" ? (
    <ArrowUp className="h-3 w-3" />
  ) : (
    <ArrowDown className="h-3 w-3" />
  );
}

function getSceneValue(
  stats: AttributionStats | null,
  col: SortColumn,
): number {
  if (!stats) return -1;
  switch (col) {
    case "total":
      return stats.total;
    case "human":
      return stats.human + stats.unmarked;
    case "ai":
      return stats.ai;
    case "unknown":
      return stats.unknown;
    case "aiPct":
      return stats.total > 0 ? stats.ai / stats.total : 0;
    default:
      return 0;
  }
}

export function AttributionProjectView() {
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);
  const setScope = useAttributionStore((s) => s.setScope);
  const projectId = useCurrentProjectId();

  const [statsMap, setStatsMap] = useState<Record<string, AttributionStats>>(
    {},
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [collapsedChapters, setCollapsedChapters] = useState<Set<string>>(
    new Set(),
  );
  const [sortCol, setSortCol] = useState<SortColumn>("scene");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const sceneIds = nodes.filter((n) => n.nodeType === "scene").map((n) => n.id);
  const sceneIdsKey = sceneIds.join(",");

  const load = useCallback(() => {
    if (sceneIds.length === 0) return;
    setIsLoading(true);
    loadProjectAttributionStats(sceneIds)
      .then((map) => setStatsMap(map))
      .catch(console.error)
      .finally(() => setIsLoading(false));
    // sceneIds is derived from sceneIdsKey for a stable string dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneIdsKey]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleChapter = (id: string) =>
    setCollapsedChapters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleSortCol = (col: SortColumn) => {
    if (col === sortCol) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir(col === "scene" ? "asc" : "desc");
    }
  };

  const handleRowClick = (sceneId: string) => {
    setActiveScene(sceneId);
    setScope("scene");
  };

  const handleExport = useCallback(
    async (format: "json" | "html") => {
      if (!projectId || isExporting) return;
      setIsExporting(true);
      try {
        const report = await buildProjectAuthorshipReport(projectId);
        const datestamp = new Date().toISOString().slice(0, 10);
        if (format === "json") {
          downloadTextFile(
            exportAuthorshipJson(report),
            `authorship-report-${datestamp}.json`,
            "application/json",
          );
        } else {
          downloadTextFile(
            exportAuthorshipHtml(report),
            `authorship-report-${datestamp}.html`,
            "text/html",
          );
        }
      } catch (e) {
        console.error("[AuthorshipReport] export failed", e);
      } finally {
        setIsExporting(false);
      }
    },
    [projectId, isExporting],
  );

  const chapters = nodes.filter((n) => n.nodeType === "folder");
  const scenesByChapter: Record<string, typeof nodes> = {};
  for (const node of nodes) {
    if (node.nodeType === "scene" && node.parentId) {
      if (!scenesByChapter[node.parentId]) scenesByChapter[node.parentId] = [];
      scenesByChapter[node.parentId].push(node);
    }
  }

  if (chapters.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{t("chat.noScenes")}</p>
    );
  }

  const thClass =
    "px-2 py-1 text-left font-normal text-muted-foreground whitespace-nowrap";
  const numThClass = `${thClass} text-right`;

  return (
    <div className="space-y-1">
      {/* Refresh + Export */}
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={() => handleExport("json")}
          disabled={isExporting || !projectId}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
          title={t("attribution.exportProjectReportTitle")}
        >
          <Download className="h-3 w-3" />
          {t("attribution.exportJson")}
        </button>
        <button
          type="button"
          onClick={() => handleExport("html")}
          disabled={isExporting || !projectId}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
          title={t("attribution.exportProjectReportTitle")}
        >
          <Download className="h-3 w-3" />
          {t("attribution.exportHtml")}
        </button>
        <button
          type="button"
          onClick={load}
          disabled={isLoading}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
          title={t("attribution.refresh")}
        >
          <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
          {t("attribution.refresh")}
        </button>
      </div>

      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-border">
            {(
              [
                ["scene", thClass],
                ["total", numThClass],
                ["human", numThClass],
                ["ai", numThClass],
                ["unknown", numThClass],
                ["aiPct", numThClass],
              ] as [SortColumn, string][]
            ).map(([col, cls]) => (
              <th key={col} className={cls}>
                <button
                  type="button"
                  onClick={() => handleSortCol(col)}
                  className="inline-flex items-center gap-0.5 hover:text-foreground transition-colors"
                  title={
                    sortCol === col && sortDir === "asc"
                      ? t("attribution.sortDesc")
                      : t("attribution.sortAsc")
                  }
                >
                  {t(
                    `attribution.column${col.charAt(0).toUpperCase()}${col.slice(1)}`,
                  )}
                  <SortIcon col={col} active={sortCol} dir={sortDir} />
                </button>
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {chapters.map((chapter) => {
            const rawScenes = scenesByChapter[chapter.id] ?? [];
            const isCollapsed = collapsedChapters.has(chapter.id);

            const chapterStats = rawScenes.reduce(
              (acc, s) => {
                const st = statsMap[s.id];
                if (!st) return acc;
                return {
                  human: acc.human + st.human + st.unmarked,
                  ai: acc.ai + st.ai,
                  unknown: acc.unknown + st.unknown,
                  total: acc.total + st.total,
                };
              },
              { human: 0, ai: 0, unknown: 0, total: 0 },
            );

            const aiPct =
              chapterStats.total > 0
                ? Math.round((chapterStats.ai / chapterStats.total) * 100)
                : 0;

            const scenes: SceneRow[] = rawScenes.map((s) => ({
              id: s.id,
              title: s.title,
              stats: statsMap[s.id] ?? null,
            }));

            if (sortCol !== "scene") {
              scenes.sort((a, b) => {
                const va = getSceneValue(a.stats, sortCol);
                const vb = getSceneValue(b.stats, sortCol);
                return sortDir === "asc" ? va - vb : vb - va;
              });
            } else if (sortDir === "desc") {
              scenes.reverse();
            }

            return (
              <React.Fragment key={chapter.id}>
                {/* Chapter row */}
                <tr
                  key={chapter.id}
                  className="hover:bg-accent/50 cursor-pointer font-medium"
                  onClick={() => toggleChapter(chapter.id)}
                >
                  <td className="px-2 py-1">
                    <span className="flex items-center gap-1">
                      {isCollapsed ? (
                        <ChevronRight className="h-3 w-3 shrink-0" />
                      ) : (
                        <ChevronDown className="h-3 w-3 shrink-0" />
                      )}
                      <span className="truncate">{chapter.title}</span>
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {chapterStats.total}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {chapterStats.human}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {chapterStats.ai}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {chapterStats.unknown}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {aiPct}%
                  </td>
                </tr>

                {/* Scene rows */}
                {!isCollapsed &&
                  scenes.map(({ id, title, stats: st }) => {
                    const aiP =
                      st && st.total > 0
                        ? Math.round((st.ai / st.total) * 100)
                        : 0;
                    const humanV = st ? st.human + st.unmarked : 0;
                    return (
                      <tr
                        key={id}
                        className="hover:bg-accent/40 cursor-pointer"
                        onClick={() => handleRowClick(id)}
                      >
                        <td className="pl-6 pr-2 py-0.5 text-muted-foreground">
                          <span className="truncate block max-w-[160px]">
                            {title}
                          </span>
                        </td>
                        {st ? (
                          <>
                            <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                              {st.total}
                            </td>
                            <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                              {humanV}
                            </td>
                            <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                              {st.ai}
                            </td>
                            <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                              {st.unknown}
                            </td>
                            <td className="px-2 py-0.5">
                              <div className="flex items-center gap-1">
                                <span className="tabular-nums text-muted-foreground w-7 text-right shrink-0">
                                  {aiP}%
                                </span>
                                <div className="w-16 shrink-0">
                                  <BreakdownBar
                                    human={humanV}
                                    ai={st.ai}
                                    unknown={st.unknown}
                                    total={st.total}
                                    height={6}
                                  />
                                </div>
                              </div>
                            </td>
                          </>
                        ) : (
                          <td
                            colSpan={5}
                            className="px-2 py-0.5 text-right text-muted-foreground/40"
                          >
                            —
                          </td>
                        )}
                      </tr>
                    );
                  })}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
