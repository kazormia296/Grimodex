import { useEffect, useMemo, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  ZoomIn,
  ZoomOut,
  CalendarRange,
  CalendarCog,
  AlertTriangle,
} from "lucide-react";
import { useProjectStore } from "@/features/project/projectStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useTimelineStore } from "@/features/timeline/timelineStore";
import { useChronicleStore } from "./chronicleStore";
import {
  listEvents,
  listSceneEvents,
  listEventRelations,
  addEventRelation,
  removeEventRelation,
  createEvent,
  updateEvent,
  deleteEvent,
  type EventRow,
  type SceneEventRow,
  type EventRelationRow,
} from "./api";
import { findCausalityConflicts, causalIssueEventIds } from "./eventCausality";
import { eventPositions, buildCausalEdges } from "./chronicleEdges";
import { findTwoPlacesConflicts, twoPlacesEventIds } from "./twoPlaces";
import { buildChronicleLaneModel } from "./chronicleLaneModel";
import { scaleEvents } from "./chronicleTimeScale";
import { ChronicleViewport } from "./ChronicleViewport";
import { ChronicleInspector } from "./ChronicleInspector";
import { ChronicleCalendarEditor } from "./ChronicleCalendarEditor";
import { useSeasonConflicts } from "./useSeasonConflicts";

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
  const updateStoryTime = useTreeStore((s) => s.updateStoryTime);
  const nodes = useTreeStore((s) => s.nodes);
  const timelineSelected = useTimelineStore((s) => s.selectedNodeIds);

  const [events, setEvents] = useState<EventRow[]>([]);
  const [sceneLinks, setSceneLinks] = useState<SceneEventRow[]>([]);
  const [relations, setRelations] = useState<EventRelationRow[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const scenedEventIds = useMemo(
    () => new Set(sceneLinks.map((l) => l.eventId)),
    [sceneLinks],
  );

  // Timeline で選択中のシーンに紐づく event（関連ハイライト）。
  const relatedIds = useMemo(() => {
    if (timelineSelected.length === 0) return new Set<string>();
    const sel = new Set(timelineSelected);
    return new Set(
      sceneLinks.filter((l) => sel.has(l.sceneId)).map((l) => l.eventId),
    );
  }, [timelineSelected, sceneLinks]);

  const people = useMemo(
    () => entries.map((e) => ({ id: e.id, name: e.name })),
    [entries],
  );

  useEffect(() => {
    if (!projectId) {
      setEvents([]);
      setSceneLinks([]);
      setRelations([]);
      return;
    }
    let cancelled = false;
    listEvents(projectId)
      .then(async (rows) => {
        if (cancelled) return;
        setEvents(rows);
        const [links, rels] = await Promise.all([
          listSceneEvents(rows.map((e) => e.id)),
          listEventRelations(projectId),
        ]);
        if (!cancelled) {
          setSceneLinks(links);
          setRelations(rels);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEvents([]);
          setSceneLinks([]);
          setRelations([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const {
    hasCalendar,
    calendar,
    conflicts,
    conflictIds,
    ageConflicts,
    ageConflictIds,
    saveCalendar,
  } = useSeasonConflicts({ projectId, events, links: sceneLinks });
  const [calendarEditorOpen, setCalendarEditorOpen] = useState(false);

  // 因果矛盾（効果が原因より前）。
  const causalConflicts = useMemo(
    () => findCausalityConflicts({ events, relations }),
    [events, relations],
  );
  // 2か所同時（同一人物が同時刻に別場所）。
  const twoPlacesConflicts = useMemo(
    () => findTwoPlacesConflicts({ events }),
    [events],
  );
  // 季節 + 年齢 + 因果 + 2か所同時 の矛盾を統合した警告対象 eventId 集合。
  const issueIds = useMemo(
    () =>
      new Set([
        ...conflictIds,
        ...ageConflictIds,
        ...causalIssueEventIds(causalConflicts),
        ...twoPlacesEventIds(twoPlacesConflicts),
      ]),
    [conflictIds, ageConflictIds, causalConflicts, twoPlacesConflicts],
  );

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

  // 因果エッジの描画幾何（原因→結果・矛盾は赤）。
  const causalEdges = useMemo(() => {
    const xById = new Map([...scaled].map(([k, v]) => [k, v.x]));
    const positions = eventPositions(model, xById);
    const conflictKeys = new Set(
      causalConflicts.map((c) => `${c.causeId}|${c.effectId}`),
    );
    return buildCausalEdges(relations, positions, conflictKeys);
  }, [scaled, model, relations, causalConflicts]);

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

  // 選択 event に紐づくシーン id（pull/stamp 対象）。
  const selectedSceneIds = useMemo(
    () =>
      selected
        ? sceneLinks
            .filter((l) => l.eventId === selected.id)
            .map((l) => l.sceneId)
        : [],
    [selected, sceneLinks],
  );

  // stamp: event の ordinal を参照シーンの storyTimeOrder へ刻む（片方向・非破壊）。
  const handleStamp = useCallback(async () => {
    if (!selected) return;
    await Promise.all(
      selectedSceneIds.map((sceneId) =>
        updateStoryTime(sceneId, selected.ordinal),
      ),
    );
  }, [selected, selectedSceneIds, updateStoryTime]);

  // pull: 参照シーンの storyTimeOrder を event の ordinal へ取り込む。
  const handlePull = useCallback(async () => {
    if (!selected) return;
    const nodeById = new Map(nodes.map((nd) => [nd.id, nd]));
    const order = selectedSceneIds
      .map((sid) => nodeById.get(sid)?.storyTimeOrder ?? null)
      .find((o): o is string => o != null);
    if (!order) return;
    setEvents((evs) =>
      evs.map((e) => (e.id === selected.id ? { ...e, ordinal: order } : e)),
    );
    void updateEvent(selected.id, { ordinal: order });
  }, [selected, selectedSceneIds, nodes]);

  // 選択 event の原因（この event を効果とする関係の cause）。
  const selectedCauseIds = useMemo(
    () =>
      selected
        ? relations
            .filter((r) => r.effectId === selected.id)
            .map((r) => r.causeId)
        : [],
    [selected, relations],
  );
  const selectedHasCausalIssue = useMemo(
    () =>
      selected
        ? causalConflicts.some(
            (c) => c.causeId === selected.id || c.effectId === selected.id,
          )
        : false,
    [selected, causalConflicts],
  );

  const handleAddCause = useCallback(
    async (causeId: string) => {
      if (!selected || !projectId) return;
      await addEventRelation(projectId, causeId, selected.id);
      refresh();
    },
    [selected, projectId, refresh],
  );
  const handleRemoveCause = useCallback(
    async (causeId: string) => {
      if (!selected) return;
      await removeEventRelation(causeId, selected.id);
      refresh();
    },
    [selected, refresh],
  );

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
        <button
          type="button"
          onClick={() => setCalendarEditorOpen((o) => !o)}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
          title={t("chronicle.calendarEditor", "暦の設定")}
        >
          <CalendarCog className="size-3.5" />
          {hasCalendar
            ? t("chronicle.calendar", "暦")
            : t("chronicle.setupCalendar", "暦を設定")}
        </button>
        {hasCalendar && conflicts.length > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-amber-600">
            <AlertTriangle className="size-3.5" />
            {t("chronicle.conflictCount", "季節矛盾 {{count}} 件", {
              count: conflicts.length,
            })}
          </span>
        ) : null}
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

      {calendarEditorOpen && (
        <ChronicleCalendarEditor
          initial={calendar}
          onSave={(cal) => void saveCalendar(cal)}
          onClose={() => setCalendarEditorOpen(false)}
        />
      )}

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
            conflictIds={issueIds}
            relatedIds={relatedIds}
            causalEdges={causalEdges}
          />
        )}
      </div>

      {selected && (
        <ChronicleInspector
          event={selected}
          people={people}
          conflicts={conflicts.filter((c) => c.eventId === selected.id)}
          ageConflicts={ageConflicts.filter((c) => c.eventId === selected.id)}
          hasTwoPlacesIssue={twoPlacesConflicts.some(
            (c) => c.eventA === selected.id || c.eventB === selected.id,
          )}
          linkedSceneCount={selectedSceneIds.length}
          allEvents={events}
          causeIds={selectedCauseIds}
          hasCausalIssue={selectedHasCausalIssue}
          onAddCause={handleAddCause}
          onRemoveCause={handleRemoveCause}
          onStamp={handleStamp}
          onPull={handlePull}
          onPatch={handlePatch}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
