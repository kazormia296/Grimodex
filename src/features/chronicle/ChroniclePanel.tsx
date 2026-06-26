import { useEffect, useMemo, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Plus, ZoomIn, ZoomOut, CalendarRange } from "lucide-react";
import { useProjectStore } from "@/features/project/projectStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useChronicleStore } from "./chronicleStore";
import {
  listEvents,
  listSceneEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  type EventRow,
} from "./api";
import { buildChronicleLaneModel } from "./chronicleLaneModel";
import { scaleEvents } from "./chronicleTimeScale";
import { ChronicleViewport } from "./ChronicleViewport";
import { ChronicleInspector } from "./ChronicleInspector";

const GUTTER_X = 120;
const STEP_BASE = 120;

/**
 * 作中年表(Chronicle)パネル — 人物レーン×作中時間軸の SVG 年表（P1b）。
 * 座標数学は chronicleTimeScale / chronicleLaneModel（純関数）に委譲。
 */
export function ChroniclePanel() {
  const { t } = useTranslation();
  const projectId = useProjectStore((s) => s.currentProjectId);
  const entries = useCodexStore((s) => s.entries);
  const zoom = useChronicleStore((s) => s.zoom);
  const setZoom = useChronicleStore((s) => s.setZoom);
  const selectedEventId = useChronicleStore((s) => s.selectedEventId);
  const setSelectedEventId = useChronicleStore((s) => s.setSelectedEventId);

  const [events, setEvents] = useState<EventRow[]>([]);
  const [scenedEventIds, setScenedEventIds] = useState<Set<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);

  const people = useMemo(
    () => entries.map((e) => ({ id: e.id, name: e.name })),
    [entries],
  );

  useEffect(() => {
    if (!projectId) {
      setEvents([]);
      setScenedEventIds(new Set());
      return;
    }
    let cancelled = false;
    listEvents(projectId)
      .then(async (rows) => {
        if (cancelled) return;
        setEvents(rows);
        const links = await listSceneEvents(rows.map((e) => e.id));
        if (!cancelled) setScenedEventIds(new Set(links.map((l) => l.eventId)));
      })
      .catch(() => {
        if (!cancelled) {
          setEvents([]);
          setScenedEventIds(new Set());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const model = useMemo(
    () =>
      buildChronicleLaneModel({
        events: events.map((e) => ({
          id: e.id,
          primaryCodexId: e.primaryCodexId,
          ordinal: e.ordinal,
          precision: e.precision,
          isOffpage: !scenedEventIds.has(e.id),
          isInterval: e.endTime != null,
        })),
        people,
      }),
    [events, scenedEventIds, people],
  );

  const n = events.length;
  const innerWanted = Math.max(1, n - 1) * STEP_BASE * zoom;
  const contentW = 2 * GUTTER_X + innerWanted;

  const scaled = useMemo(() => {
    const pts = scaleEvents(
      events.map((e) => ({
        id: e.id,
        ordinal: e.ordinal,
        startTime: e.startTime,
        endTime: e.endTime,
      })),
      { width: contentW, padX: GUTTER_X, zoom: 1, scrollOffset: 0 },
    );
    return new Map(pts.map((p) => [p.eventId, p]));
  }, [events, contentW]);

  const selected = useMemo(
    () => events.find((e) => e.id === selectedEventId) ?? null,
    [events, selectedEventId],
  );

  const handleAdd = useCallback(async () => {
    if (!projectId) return;
    const ev = await createEvent({
      projectId,
      title: t("chronicle.newEvent", "新しい出来事"),
    });
    setSelectedEventId(ev.id);
    refresh();
  }, [projectId, t, refresh, setSelectedEventId]);

  const handlePatch = useCallback(
    (patch: Partial<EventRow>) => {
      if (!selected) return;
      const id = selected.id;
      setEvents((evs) =>
        evs.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      );
      void updateEvent(id, patch);
    },
    [selected],
  );

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    await deleteEvent(selected.id);
    setSelectedEventId(null);
    refresh();
  }, [selected, refresh, setSelectedEventId]);

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
          {t("chronicle.count", "{{count}} 件", { count: n })}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setZoom(zoom / 1.25)}
            className="rounded p-1 hover:bg-accent"
            aria-label={t("chronicle.zoomOut", "縮小")}
          >
            <ZoomOut className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setZoom(zoom * 1.25)}
            className="rounded p-1 hover:bg-accent"
            aria-label={t("chronicle.zoomIn", "拡大")}
          >
            <ZoomIn className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={handleAdd}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent"
          >
            <Plus className="size-3.5" /> {t("chronicle.add", "追加")}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {n === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            {t(
              "chronicle.empty",
              "出来事がまだありません。「追加」で作成できます。",
            )}
          </div>
        ) : (
          <ChronicleViewport
            model={model}
            scaled={scaled}
            width={contentW}
            gutterX={GUTTER_X}
            selectedEventId={selectedEventId}
            onSelectEvent={setSelectedEventId}
          />
        )}
      </div>

      {selected && (
        <ChronicleInspector
          event={selected}
          people={people}
          onPatch={handlePatch}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
