import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Plus,
  ZoomIn,
  ZoomOut,
  CalendarCog,
  AlertTriangle,
  Sparkles,
  Spline,
} from "lucide-react";
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
// 素の Drizzle mutation（api.ts）は抽出ウィザード等の非 tracked 経路用に残す。
import {
  uiCreateEvent,
  uiUpdateEvent,
  uiDeleteEvent,
  uiAddEventRelation,
  uiRemoveEventRelation,
} from "@/features/agent-writes/event";
import { findCausalityConflicts, causalIssueEventIds } from "./eventCausality";
import { eventPositions, buildCausalEdges } from "./chronicleEdges";
import { findTwoPlacesConflicts, twoPlacesEventIds } from "./twoPlaces";
import { buildChronicleLaneModel } from "./chronicleLaneModel";
import { scaleEvents } from "./chronicleTimeScale";
import { ChronicleViewport } from "./ChronicleViewport";
import { ChronicleInspector } from "./ChronicleInspector";
import { ChronicleCalendarEditor } from "./ChronicleCalendarEditor";
import { ChronicleExtractDialog } from "./ChronicleExtractDialog";
import { ChronicleTieView } from "./ChronicleTieView";
import { buildTieView } from "./tieView";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
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
  // 主人物ピッカーは character、場所ピッカーは location に種別フィルタする
  // （レーン主軸の people は任意 Codex 可なので全件のまま）。
  const characters = useMemo(
    () =>
      entries
        .filter((e) => e.type === "character")
        .map((e) => ({ id: e.id, name: e.name })),
    [entries],
  );
  const locations = useMemo(
    () =>
      entries
        .filter((e) => e.type === "location")
        .map((e) => ({ id: e.id, name: e.name })),
    [entries],
  );
  // AI 秘匿の reveal アンカー候補（読む順に並べたシーン）。
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
    // プロジェクト切替時（reloadKey だけの refresh は除く）は、前プロジェクトの
    // events/links/relations が画面と編集可能な Inspector に残らないよう、await の
    // 前に同期的に local state と選択を捨てる。async gap 中に他プロジェクトの出来事を
    // 誤って編集できないよう selectedEventId も即 null にする。
    if (loadedProjectIdRef.current !== projectId) {
      loadedProjectIdRef.current = projectId;
      setEvents([]);
      setSceneLinks([]);
      setRelations([]);
      setSelectedEventId(null);
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
  const [calendarEditorOpen, setCalendarEditorOpen] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
  const [tieMode, setTieMode] = useState(false);

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

  // タイ線複合ビュー（reading 順 scene ↔ 作中時間 event）。tieMode のときだけ算出。
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
    const TIE_PAD = 40;
    const width = 2 * TIE_PAD + Math.max(1, maxCount - 1) * STEP_BASE * zoom;
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
  }, [tieMode, nodes, sceneLinks, events, zoom]);

  const selected = useMemo(
    () => events.find((e) => e.id === selectedEventId) ?? null,
    [events, selectedEventId],
  );

  const [creating, setCreating] = useState(false);
  const handleAdd = useCallback(async () => {
    // 二重発火ガード: 連打しても ordinal 採番が競合しないよう in-flight 中は弾く。
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
      const prev = selected; // 楽観適用前のスナップショット（失敗時に巻き戻す）
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
    // ストア更新（楽観 state なし）。失敗はエラー通知のみ。
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

  // pull: 参照シーンの storyTimeOrder を event の ordinal へ取り込む。
  const handlePull = useCallback(async () => {
    if (!selected || !projectId) return;
    const nodeById = new Map(nodes.map((nd) => [nd.id, nd]));
    const order = selectedSceneIds
      .map((sid) => nodeById.get(sid)?.storyTimeOrder ?? null)
      .find((o): o is string => o != null);
    if (!order) return;
    const id = selected.id;
    const prev = selected; // 失敗時に巻き戻すスナップショット
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
        actions={
          <>
            <button
              type="button"
              onClick={() => setTieMode((m) => !m)}
              className={`rounded p-1 hover:bg-accent ${tieMode ? "text-primary" : ""}`}
              aria-label={t("chronicle.tieView", "読む順×作中時間")}
              title={t("chronicle.tieView", "読む順×作中時間")}
            >
              <Spline className="size-3.5" />
            </button>
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
              onClick={() => setExtractOpen(true)}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent"
              title={t("chronicle.extract.title", "本文から出来事を抽出")}
            >
              <Sparkles className="size-3.5" />{" "}
              {t("chronicle.extractShort", "抽出")}
            </button>
            <button
              type="button"
              onClick={handleAdd}
              disabled={creating}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="size-3.5" /> {t("chronicle.add", "追加")}
            </button>
          </>
        }
      >
        <button
          type="button"
          onClick={() => setCalendarEditorOpen((o) => !o)}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent"
          title={t("chronicle.calendarEditor", "暦の設定")}
        >
          <CalendarCog className="size-3.5" />
          {hasCalendar
            ? t("chronicle.calendar", "暦")
            : t("chronicle.setupCalendar", "暦を設定")}
        </button>
        {hasCalendar && conflicts.length > 0 ? (
          <span className="inline-flex items-center gap-1 text-amber-600">
            <AlertTriangle className="size-3.5" />
            {t("chronicle.conflictCount", "季節矛盾 {{count}} 件", {
              count: conflicts.length,
            })}
          </span>
        ) : null}
      </PanelHeader>

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
        ) : tieMode && tieView ? (
          <ChronicleTieView
            model={tieView.model}
            width={tieView.width}
            height={180}
          />
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
          characters={characters}
          locations={locations}
          scenes={scenes}
          calendar={calendar ?? { daysPerYear: 360, seasonBoundaries: [] }}
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

      <ChronicleExtractDialog
        open={extractOpen}
        onOpenChange={setExtractOpen}
        onImported={refresh}
      />
    </div>
  );
}
