import { useState, useEffect, useCallback } from "react";
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
import { useAttributionStore } from "./attributionStore";
import { loadProjectAttributionStats } from "./projectStats";
import { BreakdownBar } from "./BreakdownBar";
import type { AttributionStats } from "./attributionStats";

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

  const [statsMap, setStatsMap] = useState<Record<string, AttributionStats>>(
    {},
  );
  const [isLoading, setIsLoading] = useState(false);
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
    // sceneIds is derived from sceneIdsKey for stable dependency
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

  const chapters = nodes.filter((n) => n.nodeType === "folder");
  const scenesByChapter: Record<string, typeof nodes> = {};
  for (const node of nodes) {
    if (node.nodeType === "scene" && node.parentId) {
      if (!scenesByChapter[node.parentId]) scenesByChapter[node.parentId] = [];
      scenesByChapter[node.parentId].push(node);
    }
  }

  if (isLoading) {
    return (
      <p className="text-xs text-muted-foreground animate-pulse">
        {t("common.loading")}
      </p>
    );
  }

  if (chapters.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{t("chat.noScenes")}</p>
    );
  }

  const ColHeader = ({ col, label }: { col: SortColumn; label: string }) => (
    <button
      type="button"
      onClick={() => handleSortCol(col)}
      className="flex items-center gap-0.5 hover:text-foreground transition-colors"
      title={
        sortCol === col && sortDir === "asc"
          ? t("attribution.sortDesc")
          : t("attribution.sortAsc")
      }
    >
      {label}
      <SortIcon col={col} active={sortCol} dir={sortDir} />
    </button>
  );

  return (
    <div className="space-y-1">
      {/* Refresh button */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
          title={t("attribution.refresh")}
        >
          <RefreshCw className="h-3 w-3" />
          {t("attribution.refresh")}
        </button>
      </div>

      {/* Table header */}
      <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-2 px-2 py-1 text-xs text-muted-foreground border-b border-border">
        <ColHeader col="scene" label={t("attribution.columnScene")} />
        <ColHeader col="total" label={t("attribution.columnTotal")} />
        <ColHeader col="human" label={t("attribution.columnHuman")} />
        <ColHeader col="ai" label={t("attribution.columnAi")} />
        <ColHeader col="unknown" label={t("attribution.columnUnknown")} />
        <ColHeader col="aiPct" label={t("attribution.columnAiPct")} />
      </div>

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

        // Sort scenes
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
          <div key={chapter.id}>
            {/* Chapter row */}
            <button
              type="button"
              onClick={() => toggleChapter(chapter.id)}
              className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-x-2 w-full items-center rounded px-2 py-1 text-xs font-medium hover:bg-accent/50"
            >
              <span className="flex items-center gap-1 text-left">
                {isCollapsed ? (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                )}
                <span className="truncate">{chapter.title}</span>
              </span>
              <span className="tabular-nums text-right text-muted-foreground">
                {chapterStats.total}
              </span>
              <span className="tabular-nums text-right text-muted-foreground">
                {chapterStats.human}
              </span>
              <span className="tabular-nums text-right text-muted-foreground">
                {chapterStats.ai}
              </span>
              <span className="tabular-nums text-right text-muted-foreground">
                {chapterStats.unknown}
              </span>
              <span className="tabular-nums text-right text-muted-foreground">
                {aiPct}%
              </span>
            </button>

            {!isCollapsed && (
              <div className="ml-4 space-y-0.5">
                {scenes.map(({ id, title, stats: st }) => {
                  const aiP =
                    st && st.total > 0
                      ? Math.round((st.ai / st.total) * 100)
                      : 0;
                  const humanV = st ? st.human + st.unmarked : 0;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => handleRowClick(id)}
                      className="grid grid-cols-[1fr_auto_auto_auto_auto_minmax(60px,auto)] gap-x-2 w-full items-center rounded px-2 py-0.5 text-xs hover:bg-accent/40 cursor-pointer"
                    >
                      <span className="truncate text-left text-muted-foreground">
                        {title}
                      </span>
                      {st ? (
                        <>
                          <span className="tabular-nums text-right text-muted-foreground">
                            {st.total}
                          </span>
                          <span className="tabular-nums text-right text-muted-foreground">
                            {humanV}
                          </span>
                          <span className="tabular-nums text-right text-muted-foreground">
                            {st.ai}
                          </span>
                          <span className="tabular-nums text-right text-muted-foreground">
                            {st.unknown}
                          </span>
                          <div className="flex items-center gap-1">
                            <span className="tabular-nums text-right text-muted-foreground w-8">
                              {aiP}%
                            </span>
                            <div className="flex-1">
                              <BreakdownBar
                                human={humanV}
                                ai={st.ai}
                                unknown={st.unknown}
                                total={st.total}
                                height={6}
                              />
                            </div>
                          </div>
                        </>
                      ) : (
                        <span className="col-span-5 text-muted-foreground/40 text-right">
                          —
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
