import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { PanelHeader } from "@/features/layout/PanelHeader";
import { useProjectStore } from "@/features/project/projectStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useTimelineStore } from "@/features/timeline/timelineStore";
import { useChronicleStore } from "./chronicleStore";
import {
  listEvents,
  listSceneEvents,
  listEventRelations,
  type EventRow,
  type SceneEventRow,
  type EventRelationRow,
} from "./api";
// 手動 CRUD は tracked-write（undo/Linter 連動・surface="manual"）経由で書き込む。
import {
  uiCreateEvent,
  uiUpdateEvent,
  uiDeleteEvent,
  uiAddEventRelation,
  uiRemoveEventRelation,
} from "@/features/agent-writes/event";
import { findCausalityConflicts, causalIssueEventIds } from "./eventCausality";
import { findTwoPlacesConflicts, twoPlacesEventIds } from "./twoPlaces";
import {
  effectiveDays,
  fitAll,
  zoomByCenter,
  type View,
} from "./chronicleAxis";
import {
  buildChronicleLayout,
  causalConflictPairSet,
  type LaneDensity,
  type LayoutEventInput,
  type LayoutLane,
} from "./chronicleLayout";
import type { ChronicleCalendar, DateLang } from "./chronicleTime";
import type { MarkerEvent } from "./EventMarker";
import { ChronicleViewport } from "./ChronicleViewport";
import { ChronicleToolbar } from "./ChronicleToolbar";
import { ChronicleInspector } from "./ChronicleInspector";
import { ChronicleCalendarEditor } from "./ChronicleCalendarEditor";
import { ChronicleExtractDialog } from "./ChronicleExtractDialog";
import { ChronicleTieView } from "./ChronicleTieView";
import { buildTieView } from "./tieView";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import { useSeasonConflicts } from "./useSeasonConflicts";

const TIE_PAD = 40;
const TIE_STEP = 120;

/**
 * 作中年表(Chronicle)パネル — 人物/場所レーン×作中時間軸の pan/zoom 年表。
 * 座標数学は chronicleAxis/Ticks/LanePack/CausalBezier（純関数）に委譲し、
 * 本コンポーネントはデータロード・状態・CRUD と各サブビューの配線を担う。
 */
export function ChroniclePanel() {
  const { t, i18n } = useTranslation();
  const lang: DateLang = i18n.language?.startsWith("en") ? "en" : "ja";
  const projectId = useProjectStore((s) => s.currentProjectId);
  const entries = useCodexStore((s) => s.entries);
  const selectedEventId = useChronicleStore((s) => s.selectedEventId);
  const setSelectedEventId = useChronicleStore((s) => s.setSelectedEventId);
  const setChronicleView = useChronicleStore((s) => s.setChronicleView);
  const updateStoryTime = useTreeStore((s) => s.updateStoryTime);
  const nodes = useTreeStore((s) => s.nodes);
  const timelineSelected = useTimelineStore((s) => s.selectedNodeIds);

  const [events, setEvents] = useState<EventRow[]>([]);
  const [sceneLinks, setSceneLinks] = useState<SceneEventRow[]>([]);
  const [relations, setRelations] = useState<EventRelationRow[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  // ビュー状態（pan/zoom）はローカル。永続値が chronicleStore にあれば復元し、
  // 無ければ初回計測時に全体へフィットする。trackW はビューポートが計測。
  const [view, setView] = useState<View>(() => {
    const s = useChronicleStore.getState();
    return s.pxPerDay != null && s.viewStartDay != null
      ? { pxPerDay: s.pxPerDay, viewStartDay: s.viewStartDay }
      : { pxPerDay: 1, viewStartDay: 0 };
  });
  const [trackW, setTrackW] = useState(0);
  // 永続ビューがあれば「フィット済み」とみなし初回オートフィットを抑止する。
  const fittedRef = useRef(useChronicleStore.getState().pxPerDay != null);

  // ユーザー操作由来のビュー変更は永続化する（drag/zoom/fit/警告ジャンプ）。
  const applyView = useCallback(
    (v: View) => {
      setView(v);
      setChronicleView(v.pxPerDay, v.viewStartDay);
    },
    [setChronicleView],
  );

  // 表示オプション（ローカル・非永続）。
  const [density, setDensity] = useState<LaneDensity>("standard");
  const [labelsOn, setLabelsOn] = useState(true);
  const [showLegend, setShowLegend] = useState(true);
  const [showEdges, setShowEdges] = useState(true);
  const [tieMode, setTieMode] = useState(false);
  const [calendarEditorOpen, setCalendarEditorOpen] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);

  const scenedEventIds = useMemo(
    () => new Set(sceneLinks.map((l) => l.eventId)),
    [sceneLinks],
  );

  // Timeline で選択中のシーンに紐づく出来事（関連ハイライト）。
  const relatedIds = useMemo(() => {
    if (timelineSelected.length === 0) return new Set<string>();
    const sel = new Set(timelineSelected);
    return new Set(
      sceneLinks.filter((l) => sel.has(l.sceneId)).map((l) => l.eventId),
    );
  }, [timelineSelected, sceneLinks]);

  // レーン候補（任意 Codex）/ 場所候補 / 開示シーン候補。
  const laneOptions = useMemo(
    () => entries.map((e) => ({ id: e.id, name: e.name, type: e.type })),
    [entries],
  );
  const locations = useMemo(
    () =>
      entries
        .filter((e) => e.type === "location")
        .map((e) => ({ id: e.id, name: e.name })),
    [entries],
  );
  const scenes = useMemo(() => {
    const order = computeGlobalSceneOrder(nodes);
    return nodes
      .filter((n) => n.nodeType === "scene")
      .map((n) => ({
        id: n.id,
        title: n.title,
        pos: order.get(n.id) ?? Number.POSITIVE_INFINITY,
      }))
      .sort((a, b) => a.pos - b.pos)
      .map(({ id, title }) => ({ id, title }));
  }, [nodes]);

  const loadedProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    // プロジェクト切替時は前プロジェクトのデータと選択を同期的に捨て、フィットも再実行。
    if (loadedProjectIdRef.current !== projectId) {
      loadedProjectIdRef.current = projectId;
      setEvents([]);
      setSceneLinks([]);
      setRelations([]);
      setSelectedEventId(null);
      // 永続ビューがあれば維持（再フィットしない）、無ければ新規プロジェクトに
      // 合わせて全体フィットし直す。
      fittedRef.current = useChronicleStore.getState().pxPerDay != null;
    }
    if (!projectId) return;
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
  }, [projectId, reloadKey, setSelectedEventId]);

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
  const cal = useMemo<ChronicleCalendar>(
    () => calendar ?? { daysPerYear: 360, seasonBoundaries: [] },
    [calendar],
  );

  const causalConflicts = useMemo(
    () => findCausalityConflicts({ events, relations }),
    [events, relations],
  );
  const twoPlacesConflicts = useMemo(
    () => findTwoPlacesConflicts({ events }),
    [events],
  );
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
  const issueCount = issueIds.size;

  // 実効日（全 event に startTime あれば実時間軸、無ければ ordinal 序列）。
  const eff = useMemo(
    () =>
      effectiveDays(
        events.map((e) => ({
          id: e.id,
          ordinal: e.ordinal,
          startTime: e.startTime,
          endTime: e.endTime,
        })),
      ),
    [events],
  );

  // trackW 計測後に未フィットなら全体表示にフィット。
  useEffect(() => {
    if (trackW > 0 && !fittedRef.current && events.length > 0) {
      fittedRef.current = true;
      setView(
        fitAll({ dataStart: eff.dataStart, dataEnd: eff.dataEnd, trackW }),
      );
    }
  }, [trackW, events.length, eff.dataStart, eff.dataEnd]);

  // レーン構築（primaryCodexId ごと・null/未知は __unassigned）。
  const lanes: LayoutLane[] = useMemo(() => {
    const entryById = new Map(entries.map((e) => [e.id, e]));
    const laneMap = new Map<string, string[]>();
    const unassignedIds: string[] = [];
    for (const ev of events) {
      const pid = ev.primaryCodexId;
      if (pid && entryById.has(pid)) {
        const arr = laneMap.get(pid);
        if (arr) arr.push(ev.id);
        else laneMap.set(pid, [ev.id]);
      } else {
        unassignedIds.push(ev.id);
      }
    }
    const ordered = [...laneMap.keys()]
      .map((id) => entryById.get(id)!)
      .sort((a, b) =>
        a.name < b.name
          ? -1
          : a.name > b.name
            ? 1
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0,
      );
    const out: LayoutLane[] = ordered.map((e) => ({
      codexId: e.id,
      name: e.name,
      kind: e.type,
      unassigned: false,
      eventIds: laneMap.get(e.id)!,
    }));
    if (unassignedIds.length > 0) {
      out.push({
        codexId: null,
        name: t("chronicle.unassigned", "未割当"),
        kind: "unassigned",
        unassigned: true,
        eventIds: unassignedIds,
      });
    }
    return out;
  }, [events, entries, t]);

  const layoutEvents: LayoutEventInput[] = useMemo(
    () =>
      events.flatMap((e) => {
        const ed = eff.byId.get(e.id);
        if (!ed) return [];
        return [
          {
            id: e.id,
            title: e.title,
            primaryCodexId: e.primaryCodexId,
            kind: e.kind,
            precision: e.precision,
            secret: e.secret,
            sceneLinked: scenedEventIds.has(e.id),
            startDay: ed.startDay,
            endDay: ed.endDay,
          },
        ];
      }),
    [events, eff, scenedEventIds],
  );

  const causalPairs = useMemo(
    () => causalConflictPairSet(causalConflicts),
    [causalConflicts],
  );

  const layout = useMemo(
    () =>
      buildChronicleLayout({
        events: layoutEvents,
        lanes,
        view,
        trackW,
        density,
        labelsOn,
        calendar: cal,
        hasCalendarAxis: eff.hasCalendarAxis,
        dataStart: eff.dataStart,
        dataEnd: eff.dataEnd,
        relations: relations.map((r) => ({
          causeId: r.causeId,
          effectId: r.effectId,
        })),
        causalConflictPairs: causalPairs,
        lang,
      }),
    [
      layoutEvents,
      lanes,
      view,
      trackW,
      density,
      labelsOn,
      cal,
      eff.hasCalendarAxis,
      eff.dataStart,
      eff.dataEnd,
      relations,
      causalPairs,
      lang,
    ],
  );

  const eventsById = useMemo(() => {
    const m = new Map<string, MarkerEvent>();
    for (const e of events) {
      m.set(e.id, {
        id: e.id,
        title: e.title,
        kind: e.kind,
        precision: e.precision,
        secret: e.secret,
        sceneLinked: scenedEventIds.has(e.id),
        primaryCodexId: e.primaryCodexId,
      });
    }
    return m;
  }, [events, scenedEventIds]);

  const selected = useMemo(
    () => events.find((e) => e.id === selectedEventId) ?? null,
    [events, selectedEventId],
  );

  const activeLaneKey = useMemo(() => {
    if (!selected) return null;
    const known =
      selected.primaryCodexId &&
      entries.some((e) => e.id === selected.primaryCodexId);
    return known ? selected.primaryCodexId : "__unassigned";
  }, [selected, entries]);

  // ── 表示操作（いずれも applyView で永続化する） ───────────
  const handleFit = useCallback(() => {
    applyView(
      fitAll({ dataStart: eff.dataStart, dataEnd: eff.dataEnd, trackW }),
    );
  }, [eff.dataStart, eff.dataEnd, trackW, applyView]);
  const handleZoom = useCallback(
    (factor: number) => applyView(zoomByCenter({ view, trackW, factor })),
    [view, trackW, applyView],
  );
  const handleGotoConflict = useCallback(() => {
    const ids = [...issueIds];
    if (ids.length === 0) return;
    const id = ids[0];
    setSelectedEventId(id);
    const ed = eff.byId.get(id);
    if (ed) {
      applyView({
        pxPerDay: view.pxPerDay,
        viewStartDay: ed.startDay - trackW / 2 / view.pxPerDay,
      });
    }
  }, [issueIds, eff, trackW, view, applyView, setSelectedEventId]);

  // ── CRUD ──────────────────────────────────────────────────
  const [creating, setCreating] = useState(false);
  const handleAdd = useCallback(async () => {
    if (!projectId || creating) return;
    setCreating(true);
    try {
      const ev = await uiCreateEvent({
        title: t("chronicle.newEvent", "新しい出来事"),
      });
      setSelectedEventId(ev.id);
      refresh();
    } catch {
      toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
    } finally {
      setCreating(false);
    }
  }, [projectId, creating, t, refresh, setSelectedEventId]);

  const handlePatch = useCallback(
    async (patch: Partial<EventRow>) => {
      if (!selected || !projectId) return;
      const id = selected.id;
      const prev = selected;
      setEvents((evs) =>
        evs.map((e) => (e.id === id ? { ...e, ...patch } : e)),
      );
      try {
        await uiUpdateEvent({ eventId: id, ...patch });
      } catch {
        setEvents((evs) => evs.map((e) => (e.id === id ? prev : e)));
        toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
      }
    },
    [selected, projectId, t],
  );

  const handleDelete = useCallback(async () => {
    if (!selected || !projectId) return;
    try {
      await uiDeleteEvent(selected.id);
      setSelectedEventId(null);
      refresh();
    } catch {
      toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
    }
  }, [selected, projectId, refresh, setSelectedEventId, t]);

  const selectedSceneIds = useMemo(
    () =>
      selected
        ? sceneLinks
            .filter((l) => l.eventId === selected.id)
            .map((l) => l.sceneId)
        : [],
    [selected, sceneLinks],
  );

  const handleStamp = useCallback(async () => {
    if (!selected) return;
    try {
      await Promise.all(
        selectedSceneIds.map((sceneId) =>
          updateStoryTime(sceneId, selected.ordinal),
        ),
      );
    } catch {
      toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
    }
  }, [selected, selectedSceneIds, updateStoryTime, t]);

  const handlePull = useCallback(async () => {
    if (!selected || !projectId) return;
    const nodeById = new Map(nodes.map((nd) => [nd.id, nd]));
    const order = selectedSceneIds
      .map((sid) => nodeById.get(sid)?.storyTimeOrder ?? null)
      .find((o): o is string => o != null);
    if (!order) return;
    const id = selected.id;
    const prev = selected;
    setEvents((evs) =>
      evs.map((e) => (e.id === id ? { ...e, ordinal: order } : e)),
    );
    try {
      await uiUpdateEvent({ eventId: id, ordinal: order });
    } catch {
      setEvents((evs) => evs.map((e) => (e.id === id ? prev : e)));
      toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
    }
  }, [selected, projectId, selectedSceneIds, nodes, t]);

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
      await uiAddEventRelation(causeId, selected.id);
      refresh();
    },
    [selected, projectId, refresh],
  );
  const handleRemoveCause = useCallback(
    async (causeId: string) => {
      if (!selected || !projectId) return;
      await uiRemoveEventRelation(causeId, selected.id);
      refresh();
    },
    [selected, projectId, refresh],
  );

  // タイ線複合ビュー（reading 順 scene ↔ 作中時間 event）。
  const tieView = useMemo(() => {
    if (!tieMode) return null;
    const readingOrder = computeGlobalSceneOrder(nodes);
    const linked = new Set(sceneLinks.map((l) => l.sceneId));
    const sceneById = new Map(nodes.map((nd) => [nd.id, nd]));
    const tieScenes = [...linked]
      .filter((sid) => sceneById.has(sid))
      .sort((a, b) => (readingOrder.get(a) ?? 0) - (readingOrder.get(b) ?? 0))
      .map((sid) => ({ id: sid, title: sceneById.get(sid)!.title }));
    const tieEvents = events.map((e) => ({
      id: e.id,
      title: e.title,
      ordinal: e.ordinal,
    }));
    const maxCount = Math.max(tieScenes.length, tieEvents.length, 1);
    const width = 2 * TIE_PAD + Math.max(1, maxCount - 1) * TIE_STEP;
    return {
      model: buildTieView({
        scenes: tieScenes,
        events: tieEvents,
        links: sceneLinks.map((l) => ({
          sceneId: l.sceneId,
          eventId: l.eventId,
        })),
        width,
        padX: TIE_PAD,
        topY: 30,
        bottomY: 150,
      }),
      width,
    };
  }, [tieMode, nodes, sceneLinks, events]);

  const n = events.length;

  if (!projectId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t("chronicle.noProject", "プロジェクトを開いてください")}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PanelHeader
        panelId="chronicle"
        count={t("chronicle.count", "{{count}} 件", { count: n })}
      />

      <ChronicleToolbar
        issueCount={issueCount}
        showLegend={showLegend}
        showEdges={showEdges}
        tieMode={tieMode}
        density={density}
        labelsOn={labelsOn}
        hasCalendar={hasCalendar}
        creating={creating}
        onNew={handleAdd}
        onExtract={() => setExtractOpen(true)}
        onCalendar={() => setCalendarEditorOpen((o) => !o)}
        onToggleTie={() => setTieMode((m) => !m)}
        onGotoConflict={handleGotoConflict}
        onToggleEdges={() => setShowEdges((s) => !s)}
        onZoomIn={() => handleZoom(1.5)}
        onZoomOut={() => handleZoom(1 / 1.5)}
        onFit={handleFit}
        onToggleLegend={() => setShowLegend((s) => !s)}
        onSetDensity={setDensity}
        onToggleLabels={() => setLabelsOn((s) => !s)}
      />

      {calendarEditorOpen && (
        <ChronicleCalendarEditor
          initial={calendar}
          onSave={(c) => void saveCalendar(c)}
          onClose={() => setCalendarEditorOpen(false)}
        />
      )}

      {n === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          {t(
            "chronicle.empty",
            "出来事がまだありません。「追加」で作成できます。",
          )}
        </div>
      ) : tieMode && tieView ? (
        <div className="flex-1 overflow-auto bg-card">
          <ChronicleTieView
            model={tieView.model}
            width={tieView.width}
            height={180}
          />
        </div>
      ) : (
        <ChronicleViewport
          view={view}
          onViewChange={applyView}
          onMeasureTrack={setTrackW}
          layout={layout}
          eventsById={eventsById}
          selectedEventId={selectedEventId}
          activeLaneKey={activeLaneKey}
          conflictIds={issueIds}
          relatedIds={relatedIds}
          showEdges={showEdges}
          labelsOn={labelsOn}
          onSelectEvent={setSelectedEventId}
        />
      )}

      {selected ? (
        <ChronicleInspector
          event={selected}
          laneOptions={laneOptions}
          locations={locations}
          scenes={scenes}
          calendar={cal}
          conflicts={conflicts.filter((c) => c.eventId === selected.id)}
          ageConflicts={ageConflicts.filter((c) => c.eventId === selected.id)}
          hasTwoPlacesIssue={twoPlacesConflicts.some(
            (c) => c.eventA === selected.id || c.eventB === selected.id,
          )}
          hasCausalIssue={selectedHasCausalIssue}
          linkedSceneCount={selectedSceneIds.length}
          allEvents={events}
          causeIds={selectedCauseIds}
          onAddCause={handleAddCause}
          onRemoveCause={handleRemoveCause}
          onStamp={handleStamp}
          onPull={handlePull}
          onPatch={handlePatch}
          onDelete={handleDelete}
          onClose={() => setSelectedEventId(null)}
          lang={lang}
        />
      ) : (
        n > 0 && (
          <div className="flex h-[60px] flex-none items-center gap-3.5 border-t border-border bg-card px-4.5">
            <span className="text-[13px] text-muted-foreground">
              {t(
                "chronicle.selectHint",
                "出来事をクリックすると、ここで詳細を編集できます。",
              )}
            </span>
            <span className="rounded-md bg-accent px-2.5 py-1 text-xs text-foreground/70">
              {t("chronicle.totalCount", "全 {{count}} 件", { count: n })}
            </span>
            {issueCount > 0 && (
              <span
                className="rounded-md px-2.5 py-1 text-xs"
                style={{
                  background: "color-mix(in oklch, #e0a23a 14%, transparent)",
                  border:
                    "1px solid color-mix(in oklch, #e0a23a 40%, transparent)",
                  color: "color-mix(in oklch, #e0a23a 75%, var(--foreground))",
                }}
              >
                {t("chronicle.issueCount", "整合警告 {{count}} 件", {
                  count: issueCount,
                })}
              </span>
            )}
            <button
              type="button"
              onClick={handleAdd}
              disabled={creating}
              className="ms-auto inline-flex h-8 items-center gap-1 rounded-lg px-3 text-xs font-medium disabled:opacity-50"
              style={{
                background: "var(--primary)",
                color: "var(--primary-foreground)",
              }}
            >
              <Plus className="size-3.5" />{" "}
              {t("chronicle.newEvent", "新しい出来事")}
            </button>
          </div>
        )
      )}

      <ChronicleExtractDialog
        open={extractOpen}
        onOpenChange={setExtractOpen}
        onImported={refresh}
      />
    </div>
  );
}
