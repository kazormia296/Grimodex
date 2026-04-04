import { useState, useEffect } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import { loadProjectAttributionStats } from "./projectStats";
import type { AttributionStats } from "./attributionStats";

export function AttributionProjectView() {
  const nodes = useTreeStore((s) => s.nodes);
  const [statsMap, setStatsMap] = useState<Record<string, AttributionStats>>(
    {},
  );
  const [isLoading, setIsLoading] = useState(false);
  const [collapsedChapters, setCollapsedChapters] = useState<Set<string>>(
    new Set(),
  );

  const sceneIds = nodes.filter((n) => n.nodeType === "scene").map((n) => n.id);

  useEffect(() => {
    if (sceneIds.length === 0) return;
    setIsLoading(true);
    loadProjectAttributionStats(sceneIds)
      .then((map) => setStatsMap(map))
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, [sceneIds.join(",")]);

  const toggleChapter = (id: string) =>
    setCollapsedChapters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

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
      <p className="text-xs text-muted-foreground animate-pulse">読み込み中…</p>
    );
  }

  if (chapters.length === 0) {
    return <p className="text-xs text-muted-foreground">シーンがありません</p>;
  }

  return (
    <div className="space-y-1">
      {chapters.map((chapter) => {
        const scenes = scenesByChapter[chapter.id] ?? [];
        const isCollapsed = collapsedChapters.has(chapter.id);

        const chapterStats = scenes.reduce(
          (acc, s) => {
            const st = statsMap[s.id];
            if (!st) return acc;
            return {
              human: acc.human + st.human + st.unmarked,
              ai: acc.ai + st.ai,
              total: acc.total + st.total,
            };
          },
          { human: 0, ai: 0, total: 0 },
        );

        const aiPct =
          chapterStats.total > 0
            ? Math.round((chapterStats.ai / chapterStats.total) * 100)
            : 0;

        return (
          <div key={chapter.id}>
            <button
              type="button"
              onClick={() => toggleChapter(chapter.id)}
              className="flex w-full items-center gap-1 rounded px-2 py-1 text-xs font-medium hover:bg-accent/50"
            >
              {isCollapsed ? (
                <ChevronRight className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronDown className="h-3 w-3 shrink-0" />
              )}
              <span className="flex-1 truncate text-left">{chapter.title}</span>
              <span className="tabular-nums text-muted-foreground">
                AI: {aiPct}% ({chapterStats.total}字)
              </span>
            </button>

            {!isCollapsed && (
              <div className="ml-4 space-y-0.5">
                {scenes.map((scene) => {
                  const st = statsMap[scene.id];
                  const aiP =
                    st && st.total > 0
                      ? Math.round((st.ai / st.total) * 100)
                      : 0;
                  const humanP =
                    st && st.total > 0
                      ? Math.round(((st.human + st.unmarked) / st.total) * 100)
                      : 0;
                  return (
                    <div
                      key={scene.id}
                      className="flex items-center gap-2 rounded px-2 py-0.5 text-xs hover:bg-accent/30"
                    >
                      <span className="flex-1 truncate text-muted-foreground">
                        {scene.title}
                      </span>
                      {st ? (
                        <>
                          <span className="tabular-nums text-blue-500/70">
                            {humanP}%人
                          </span>
                          <span className="tabular-nums text-purple-500/70">
                            {aiP}%AI
                          </span>
                          <span className="tabular-nums text-muted-foreground/60">
                            {st.total}字
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </div>
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
