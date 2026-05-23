import { useEffect, useState, useCallback } from "react";
import { Trash2 } from "lucide-react";
import { invoke } from "@/lib/tauri";
import { useLintIgnoreStore, type LintIgnoreEntry } from "./lintIgnoreStore";
import { buildBlocksFromJson } from "./projectScan";
import { loadSceneContent } from "@/features/tree/api";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useTranslation } from "react-i18next";
import { ListRowSkeletonList } from "@/components/ui/skeleton-patterns";

interface EntryRow extends LintIgnoreEntry {
  sceneTitle: string | null;
}

type StalenessStatus = "active" | "stale" | "orphan" | "unknown";

interface QueryResult {
  rows: Record<string, unknown>[];
}

async function fetchAllEntries(): Promise<EntryRow[]> {
  const r = await invoke<QueryResult>("db_execute", {
    sql: `SELECT l.id, l.rule_id, l.scene_id, l.text_snippet,
                 l.context_before, l.context_after, l.note, l.created_at,
                 t.title AS scene_title
          FROM lint_ignored_diagnostics l
          LEFT JOIN tree_nodes t ON l.scene_id = t.id
          WHERE t.project_id = ? OR t.project_id IS NULL
          ORDER BY t.title NULLS LAST, l.created_at DESC`,
    params: [getCurrentProjectId()],
    method: "all",
  });
  return r.rows.map((row) => ({
    id: String(row.id),
    rule_id: String(row.rule_id),
    scene_id: String(row.scene_id),
    text_snippet: String(row.text_snippet),
    context_before: String(row.context_before),
    context_after: String(row.context_after),
    note: row.note == null ? null : String(row.note),
    created_at: Number(row.created_at ?? 0),
    sceneTitle: row.scene_title == null ? null : String(row.scene_title),
  }));
}

async function computeStaleness(
  entries: EntryRow[],
): Promise<Map<string, StalenessStatus>> {
  const result = new Map<string, StalenessStatus>();
  const byScene = new Map<string, EntryRow[]>();

  for (const e of entries) {
    if (e.sceneTitle === null) {
      result.set(e.id, "orphan");
      continue;
    }
    const group = byScene.get(e.scene_id) ?? [];
    group.push(e);
    byScene.set(e.scene_id, group);
  }

  await Promise.all(
    Array.from(byScene.entries()).map(async ([sceneId, sceneEntries]) => {
      try {
        const content = await loadSceneContent(sceneId);
        const { sceneText } = buildBlocksFromJson(content);
        for (const e of sceneEntries) {
          const byBefore = sceneText.includes(
            e.context_before + e.text_snippet,
          );
          const byAfter = sceneText.includes(e.text_snippet + e.context_after);
          result.set(e.id, byBefore || byAfter ? "active" : "stale");
        }
      } catch {
        for (const e of sceneEntries) result.set(e.id, "unknown");
      }
    }),
  );

  return result;
}

const STALENESS_LABEL: Record<StalenessStatus, string> = {
  active: "有効",
  stale: "陳腐化",
  orphan: "孤児",
  unknown: "不明",
};

const STALENESS_CLASS: Record<StalenessStatus, string> = {
  active:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  stale:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  orphan: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  unknown: "bg-muted text-muted-foreground",
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

interface SceneGroupProps {
  sceneTitle: string | null;
  entries: EntryRow[];
  staleness: Map<string, StalenessStatus>;
  onDelete: (id: string) => Promise<void>;
}

function SceneGroup({
  sceneTitle,
  entries,
  staleness,
  onDelete,
}: SceneGroupProps) {
  const [deleting, setDeleting] = useState<string | null>(null);

  const handleDelete = useCallback(
    async (id: string) => {
      setDeleting(id);
      try {
        await onDelete(id);
      } finally {
        setDeleting(null);
      }
    },
    [onDelete],
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="sticky top-0 bg-background px-3 py-1 text-xs font-semibold text-muted-foreground border-b border-border">
        {sceneTitle ?? "（シーン不明）"}
      </div>
      {entries.map((e) => {
        const status = staleness.get(e.id) ?? "unknown";
        return (
          <div
            key={e.id}
            className="flex items-start gap-2 px-3 py-2 hover:bg-accent/50"
          >
            <div className="flex flex-1 flex-col gap-0.5 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <code className="text-[11px] rounded bg-muted px-1 py-0.5">
                  {e.rule_id}
                </code>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STALENESS_CLASS[status]}`}
                >
                  {STALENESS_LABEL[status]}
                </span>
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {formatDate(e.created_at)}
                </span>
              </div>
              <div className="text-xs text-muted-foreground truncate">
                <span className="opacity-50">{e.context_before}</span>
                <span className="font-medium text-foreground">
                  [{e.text_snippet}]
                </span>
                <span className="opacity-50">{e.context_after}</span>
              </div>
              {e.note && (
                <div className="text-[11px] text-muted-foreground italic">
                  {e.note}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => handleDelete(e.id)}
              disabled={deleting === e.id}
              className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
              title="この無視エントリを削除"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function LinterIgnoreListTab() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [staleness, setStaleness] = useState<Map<string, StalenessStatus>>(
    new Map(),
  );
  const deleteIgnore = useLintIgnoreStore((s) => s.deleteIgnore);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetchAllEntries()
      .then((rows) => {
        if (cancelled) return Promise.resolve(undefined);
        setEntries(rows);
        setLoading(false);
        return computeStaleness(rows);
      })
      .then((map) => {
        if (cancelled || !map) return;
        setStaleness(map);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteIgnore(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
      setStaleness((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    },
    [deleteIgnore],
  );

  if (loading) {
    return (
      <ListRowSkeletonList
        testId="linter-ignore-list-loading"
        className="p-2"
      />
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
        <span>{t("lintSettings.ignoreList.empty")}</span>
        <span className="text-xs">
          {t("lintSettings.ignoreList.emptyHint")}
        </span>
      </div>
    );
  }

  // Group by sceneTitle (preserving order from DB — already sorted by title)
  const groups: Array<{ title: string | null; entries: EntryRow[] }> = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (!last || last.title !== e.sceneTitle) {
      groups.push({ title: e.sceneTitle, entries: [e] });
    } else {
      last.entries.push(e);
    }
  }

  const staleCount = entries.filter((e) => {
    const s = staleness.get(e.id);
    return s === "stale" || s === "orphan";
  }).length;

  return (
    <div className="flex flex-col h-full">
      {staleCount > 0 && (
        <div className="mx-3 mt-3 rounded border border-yellow-300 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-900/20 px-3 py-2 text-xs text-yellow-800 dark:text-yellow-400">
          {t("lintSettings.ignoreList.staleWarning", { count: staleCount })}
        </div>
      )}
      <div className="flex-1 overflow-y-auto divide-y divide-border">
        {groups.map((g, i) => (
          <SceneGroup
            key={i}
            sceneTitle={g.title}
            entries={g.entries}
            staleness={staleness}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  );
}
