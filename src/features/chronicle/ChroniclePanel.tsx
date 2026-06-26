import { useEffect, useMemo, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, CalendarRange } from "lucide-react";
import { useProjectStore } from "@/features/project/projectStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { useChronicleStore } from "./chronicleStore";
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  type EventRow,
} from "./api";

/**
 * 作中年表(Chronicle)パネル — P1a 最小版。Event を ordinal 順に一覧し、
 * 追加 / タイトル編集 / 削除ができる。SVG の人物レーン年表ビューポートは P1b。
 */
export function ChroniclePanel() {
  const { t } = useTranslation();
  const projectId = useProjectStore((s) => s.currentProjectId);
  const entries = useCodexStore((s) => s.entries);
  const selectedEventId = useChronicleStore((s) => s.selectedEventId);
  const setSelectedEventId = useChronicleStore((s) => s.setSelectedEventId);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const codexName = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries) m.set(e.id, e.name);
    return m;
  }, [entries]);

  useEffect(() => {
    if (!projectId) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    listEvents(projectId)
      .then((rows) => {
        if (!cancelled) setEvents(rows);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey]);

  const sorted = useMemo(
    () => [...events].sort((a, b) => cmpKeys(a.ordinal, b.ordinal)),
    [events],
  );

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const handleAdd = useCallback(async () => {
    if (!projectId) return;
    const ev = await createEvent({
      projectId,
      title: t("chronicle.newEvent", "新しい出来事"),
    });
    setSelectedEventId(ev.id);
    refresh();
  }, [projectId, t, refresh, setSelectedEventId]);

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteEvent(id);
      if (useChronicleStore.getState().selectedEventId === id) {
        setSelectedEventId(null);
      }
      refresh();
    },
    [refresh, setSelectedEventId],
  );

  const handleRename = useCallback((id: string, title: string) => {
    setEvents((evs) => evs.map((e) => (e.id === id ? { ...e, title } : e)));
    void updateEvent(id, { title });
  }, []);

  if (!projectId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t("chronicle.noProject", "プロジェクトを開いてください")}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <CalendarRange className="size-4 opacity-70" />
        <span className="text-sm font-medium">
          {t("layout.panel.chronicle", "年表")}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("chronicle.count", "{{count}} 件", { count: events.length })}
        </span>
        <button
          type="button"
          onClick={handleAdd}
          className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent"
        >
          <Plus className="size-3.5" /> {t("chronicle.add", "追加")}
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {sorted.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            {t(
              "chronicle.empty",
              "出来事がまだありません。「追加」で作成できます。",
            )}
          </div>
        ) : (
          <ul className="divide-y">
            {sorted.map((ev) => (
              <li
                key={ev.id}
                className={`flex items-center gap-2 px-3 py-2 text-sm ${
                  selectedEventId === ev.id ? "bg-accent" : ""
                }`}
              >
                <input
                  value={ev.title}
                  onFocus={() => setSelectedEventId(ev.id)}
                  onChange={(e) => handleRename(ev.id, e.target.value)}
                  className="min-w-0 flex-1 bg-transparent outline-none"
                  placeholder={t("chronicle.untitled", "無題の出来事")}
                />
                <span className="shrink-0 text-xs text-muted-foreground">
                  {ev.startTime != null
                    ? `t=${ev.startTime}`
                    : t("chronicle.noTime", "時刻なし")}
                </span>
                {ev.primaryCodexId && (
                  <span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
                    {codexName.get(ev.primaryCodexId) ?? ""}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void handleDelete(ev.id)}
                  className="shrink-0 rounded p-1 hover:bg-destructive/10"
                  aria-label={t("chronicle.delete", "削除")}
                >
                  <Trash2 className="size-3.5 opacity-60" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
