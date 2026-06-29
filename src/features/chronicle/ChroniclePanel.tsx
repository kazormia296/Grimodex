import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus, Trash2, X } from "lucide-react";
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
  listEventParticipantsForProject,
  type EventRow,
  type SceneEventRow,
  type EventRelationRow,
  type ParticipantRow,
} from "./api";
// 手動 CRUD は tracked-write（undo/Linter 連動・surface="manual"）経由で書き込む。
import {
  uiCreateEvent,
  uiUpdateEvent,
  uiDeleteEvent,
  uiAddEventRelation,
  uiRemoveEventRelation,
  uiSetEventParticipants,
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
  laneDupId,
  decodeLaneTarget,
  GROUP_PREFIX,
  type LaneDensity,
  type LayoutEventInput,
  type LayoutLane,
} from "./chronicleLayout";
import { nextSelection } from "./chronicleSelection";
import { formatChronicleDate } from "./chronicleTime";
import type { ChronicleCalendar, DateLang } from "./chronicleTime";
import type { MarkerEvent } from "./EventMarker";
import { ChronicleViewport } from "./ChronicleViewport";
import { ChronicleToolbar } from "./ChronicleToolbar";
import { ChronicleInspector } from "./ChronicleInspector";
import { CodexEntryPicker } from "./CodexEntryPicker";
import { ChronicleExtractDialog } from "./ChronicleExtractDialog";
import { ChronicleTieView } from "./ChronicleTieView";
import { buildTieView } from "./tieView";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import { useSeasonConflicts } from "./useSeasonConflicts";

const TIE_PAD = 40;
const TIE_STEP = 120;
const MIN_PER_DAY = 1440;

/**
 * 分数日（時刻込み）を day 番号＋時刻に分解する。
 * subDay=true（時/分 zoom）なら時刻も吸着先へ更新。false（日以上 zoom）なら
 * day だけ動かし時刻(keepMinute)は保持する（=ドラッグで 0:00 にリセットしない）。
 */
function splitDayMinute(
  fracDay: number,
  subDay: boolean,
  keepMinute: number | null,
): { time: number; minute: number | null } {
  if (subDay) {
    const day = Math.floor(fracDay);
    return { time: day, minute: Math.round((fracDay - day) * MIN_PER_DAY) };
  }
  return { time: Math.round(fracDay), minute: keepMinute };
}

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
  const selectedEventIds = useChronicleStore((s) => s.selectedEventIds);
  const setSelectedEventId = useChronicleStore((s) => s.setSelectedEventId);
  const setSelection = useChronicleStore((s) => s.setSelection);
  const setChronicleView = useChronicleStore((s) => s.setChronicleView);
  const locked = useChronicleStore((s) => s.locked);
  const toggleLock = useChronicleStore((s) => s.toggleLock);
  const selectedDay = useChronicleStore((s) => s.selectedDay);
  const setSelectedPosition = useChronicleStore((s) => s.setSelectedPosition);
  // 年表 mutation/undo/redo で単調増加。これを load effect の依存に入れることで
  // Undo/Redo（bumpRevision のみ呼ぶ）後も DB から再取得して表示を更新する。
  const revisionCounter = useChronicleStore((s) => s.revisionCounter);
  const updateStoryTime = useTreeStore((s) => s.updateStoryTime);
  const nodes = useTreeStore((s) => s.nodes);
  const timelineSelected = useTimelineStore((s) => s.selectedNodeIds);

  const [events, setEvents] = useState<EventRow[]>([]);
  const [sceneLinks, setSceneLinks] = useState<SceneEventRow[]>([]);
  const [relations, setRelations] = useState<EventRelationRow[]>([]);
  // 参加者（追加レーン=複数 Codex 所属）。primaryCodexId に加え参加レーンへ描く。
  const [participants, setParticipants] = useState<ParticipantRow[]>([]);
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
  const [extractOpen, setExtractOpen] = useState(false);
  // インスペクタ高さ（上端グリップでリサイズ。選択をまたいで保持）。
  const [inspectorHeight, setInspectorHeight] = useState(340);
  // 「レーンを追加」で増やす空の未割当レーン群（id）。出来事を入れると laneGroup で永続。
  const groupCounterRef = useRef(0);
  const [emptyGroups, setEmptyGroups] = useState<string[]>([]);

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
      setParticipants([]);
      setSelectedEventId(null);
      // 位置選択(ephemeral)も捨てる。残すと handleAdd が他プロジェクトの
      // codexId/日を新規イベントへ書き込みクロスプロジェクト参照を作る。
      setSelectedPosition(null);
      setEmptyGroups([]);
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
        // 削除/undo/redo 後の stale な選択 id を実 event に整合（全削除経路を覆う）。
        useChronicleStore
          .getState()
          .sanitizeSelection(new Set(rows.map((e) => e.id)));
        const [links, rels, parts] = await Promise.all([
          listSceneEvents(rows.map((e) => e.id)),
          listEventRelations(projectId),
          listEventParticipantsForProject(projectId),
        ]);
        if (!cancelled) {
          setSceneLinks(links);
          setRelations(rels);
          setParticipants(parts);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEvents([]);
          setSceneLinks([]);
          setRelations([]);
          setParticipants([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    projectId,
    reloadKey,
    revisionCounter,
    setSelectedEventId,
    setSelectedPosition,
  ]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const {
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
          startMinute: e.startMinute,
          endMinute: e.endMinute,
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

  // 参加者（追加レーン所属）の eventId → codexId[]。
  const participantsByEvent = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of participants) {
      const arr = m.get(p.eventId);
      if (arr) arr.push(p.codexEntryId);
      else m.set(p.eventId, [p.codexEntryId]);
    }
    return m;
  }, [participants]);

  // レーン構築（primaryCodexId=本物 id。参加レーンは合成 id で複製描画。null/未知は未割当）。
  // 未割当出来事は laneGroup でグルーピングして複数の未割当レーンに分ける（基底=null/""）。
  const lanes: LayoutLane[] = useMemo(() => {
    const entryById = new Map(entries.map((e) => [e.id, e]));
    const laneMap = new Map<string, string[]>();
    // 未割当グループ: キー BASE は基底（laneGroup 無し）、それ以外は laneGroup 値。
    const BASE = "";
    const groupMap = new Map<string, string[]>();
    const pushLane = (codexId: string, id: string) => {
      const arr = laneMap.get(codexId);
      if (arr) arr.push(id);
      else laneMap.set(codexId, [id]);
    };
    const pushGroup = (g: string, id: string) => {
      const arr = groupMap.get(g);
      if (arr) arr.push(id);
      else groupMap.set(g, [id]);
    };
    for (const ev of events) {
      const pid = ev.primaryCodexId;
      if (pid && entryById.has(pid)) {
        pushLane(pid, ev.id);
      } else {
        const g = ev.laneGroup && ev.laneGroup.length ? ev.laneGroup : BASE;
        pushGroup(g, ev.id);
      }
      // 参加レーン（primary と重複せず既知の Codex）は合成 id で複製。
      for (const cid of participantsByEvent.get(ev.id) ?? []) {
        if (cid !== pid && entryById.has(cid)) {
          pushLane(cid, laneDupId(ev.id, cid));
        }
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
    // 未割当レーン群: 基底（出来事あれば）→ laneGroup を持つ群（出現順）→ 空の追加群。
    const groupKeys: string[] = [];
    if (groupMap.has(BASE)) groupKeys.push(BASE);
    for (const g of groupMap.keys()) if (g !== BASE) groupKeys.push(g);
    for (const g of emptyGroups) if (!groupMap.has(g)) groupKeys.push(g);
    const unassignedLabel = t("chronicle.unassigned", "未割当");
    groupKeys.forEach((g, idx) => {
      const eventIds = groupMap.get(g) ?? [];
      out.push({
        codexId: null,
        name: idx === 0 ? unassignedLabel : `${unassignedLabel} ${idx + 1}`,
        kind: "unassigned",
        unassigned: true,
        eventIds,
        keepEmpty: eventIds.length === 0,
        groupId: g === BASE ? undefined : g,
      });
    });
    return out;
  }, [events, entries, t, participantsByEvent, emptyGroups]);

  const layoutEvents: LayoutEventInput[] = useMemo(() => {
    const entryIds = new Set(entries.map((e) => e.id));
    return events.flatMap((e) => {
      const ed = eff.byId.get(e.id);
      if (!ed) return [];
      const base = {
        title: e.title,
        kind: e.kind,
        precision: e.precision,
        secret: e.secret,
        sceneLinked: scenedEventIds.has(e.id),
        startDay: ed.startDay,
        endDay: ed.endDay,
      };
      // 本物 id（home レーン）＋参加レーンごとの合成 id 複製。
      const out: LayoutEventInput[] = [
        { id: e.id, primaryCodexId: e.primaryCodexId, ...base },
      ];
      for (const cid of participantsByEvent.get(e.id) ?? []) {
        if (cid !== e.primaryCodexId && entryIds.has(cid)) {
          out.push({ id: laneDupId(e.id, cid), primaryCodexId: cid, ...base });
        }
      }
      return out;
    });
  }, [events, entries, eff, scenedEventIds, participantsByEvent]);

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
  // ドラッグ書き戻し時に現在のルーラー解像度（時刻 zoom か否か）を参照する。
  const rulerLevelRef = useRef<string>("day");
  rulerLevelRef.current = layout.ticks.level;

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

  // 複数選択集合（存在する出来事のみ＝削除済み id を除く）。ハイライト/一括操作に使う。
  const selectedIdSet = useMemo(() => {
    const existing = new Set(events.map((e) => e.id));
    return new Set(selectedEventIds.filter((id) => existing.has(id)));
  }, [events, selectedEventIds]);
  const multiCount = selectedIdSet.size;

  const activeLaneKey = useMemo(() => {
    if (!selected) return null;
    const known =
      selected.primaryCodexId &&
      entries.some((e) => e.id === selected.primaryCodexId);
    if (known) return selected.primaryCodexId;
    // 未割当はグループ別に強調（基底=__unassigned、追加群=__group_<g>）。
    const g =
      selected.laneGroup && selected.laneGroup.length
        ? selected.laneGroup
        : null;
    return g ? `${GROUP_PREFIX}${g}` : "__unassigned";
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
  // 暦モード中は新規イベントに既定の時刻（現在ビュー中央）を付与する。無時刻イベントを
  // 作ると hasCalendarAxis が false に倒れて全体が並び順(#1)へ落ち、期間が点に化ける。
  const defaultCreateDay = useCallback((): number | null => {
    if (!eff.hasCalendarAxis || trackW <= 0 || !(view.pxPerDay > 0))
      return null;
    return Math.round(view.viewStartDay + trackW / 2 / view.pxPerDay);
  }, [eff.hasCalendarAxis, trackW, view]);

  // 新規作成は「選択中の位置」（空白クリック/ダブルクリック由来）、無ければビュー中央へ置く。
  const handleAdd = useCallback(async () => {
    if (!projectId || creating) return;
    setCreating(true);
    try {
      const st = useChronicleStore.getState();
      const day = st.selectedDay ?? defaultCreateDay();
      const { primaryCodexId, laneGroup } = decodeLaneTarget(
        st.selectedLaneKey,
      );
      const ev = await uiCreateEvent({
        title: t("chronicle.newEvent", "新しい出来事"),
        ...(primaryCodexId ? { primaryCodexId } : {}),
        ...(laneGroup ? { laneGroup } : {}),
        ...(day != null
          ? { startTime: Math.round(day), startGranularity: "day" as const }
          : {}),
      });
      setSelectedEventId(ev.id);
      setSelectedPosition(null);
      refresh();
    } catch {
      toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
    } finally {
      setCreating(false);
    }
  }, [
    projectId,
    creating,
    t,
    refresh,
    setSelectedEventId,
    setSelectedPosition,
    defaultCreateDay,
  ]);

  // id 指定の楽観パッチ（ドラッグ移動/伸縮で使う。handlePatch は選択中専用）。
  const patchById = useCallback(
    async (id: string, patch: Partial<EventRow>) => {
      if (!projectId) return;
      const prev = events.find((e) => e.id === id);
      if (!prev) return;
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
    [projectId, events, t],
  );

  // マーカー再配置（横=startTime / 縦=レーン再割当。interval は期間維持）。
  // 時刻 zoom 中は時刻も吸着先へ、日以上 zoom では時刻を保持して day だけ動かす。
  const handleMoveEvent = useCallback(
    (id: string, newStartDay: number | null, newCodexId: string | null) => {
      const e = events.find((x) => x.id === id);
      if (!e) return;
      // 移動先レーンを実 codex 割当 or 未割当グループに解く。""=NULL クリア。
      const { primaryCodexId, laneGroup } = decodeLaneTarget(newCodexId);
      const patch: Partial<EventRow> = { primaryCodexId, laneGroup };
      if (newStartDay != null && e.startTime != null) {
        const subDay =
          rulerLevelRef.current === "hour" ||
          rulerLevelRef.current === "minute";
        const s = splitDayMinute(newStartDay, subDay, e.startMinute);
        patch.startTime = s.time;
        if (subDay) patch.startMinute = s.minute;
        if (e.endTime != null)
          patch.endTime = s.time + (e.endTime - e.startTime);
      }
      void patchById(id, patch);
    },
    [events, patchById],
  );

  // 期間端の伸縮（開始/終了を吸着位置へ。start<=end を保つ。時刻 zoom は時刻も更新）。
  const handleResizeEvent = useCallback(
    (id: string, edge: "start" | "end", newDay: number) => {
      const e = events.find((x) => x.id === id);
      if (!e || e.startTime == null) return;
      const subDay =
        rulerLevelRef.current === "hour" || rulerLevelRef.current === "minute";
      if (edge === "start") {
        const s = splitDayMinute(newDay, subDay, e.startMinute);
        const patch: Partial<EventRow> = {
          startTime: Math.min(s.time, e.endTime ?? s.time),
        };
        if (subDay) patch.startMinute = s.minute;
        void patchById(id, patch);
      } else {
        const s = splitDayMinute(newDay, subDay, e.endMinute);
        const patch: Partial<EventRow> = {
          endTime: Math.max(s.time, e.startTime),
        };
        if (subDay) patch.endMinute = s.minute;
        void patchById(id, patch);
      }
    },
    [events, patchById],
  );

  // D&D 因果エッジ作成（ドラッグ元=原因→落下先=結果）。
  const handleCreateEdge = useCallback(
    async (causeId: string, effectId: string) => {
      if (!projectId) return;
      try {
        await uiAddEventRelation(causeId, effectId);
        refresh();
      } catch {
        toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
      }
    },
    [projectId, refresh, t],
  );

  // 位置にイベント作成（ダブルクリック/コンテキストメニュー）。
  const handleCreateAt = useCallback(
    async (day: number | null, codexId: string | null) => {
      if (!projectId || creating) return;
      const d = day ?? defaultCreateDay();
      const { primaryCodexId, laneGroup } = decodeLaneTarget(codexId);
      setCreating(true);
      try {
        const ev = await uiCreateEvent({
          title: t("chronicle.newEvent", "新しい出来事"),
          ...(primaryCodexId ? { primaryCodexId } : {}),
          ...(laneGroup ? { laneGroup } : {}),
          ...(d != null
            ? { startTime: Math.round(d), startGranularity: "day" as const }
            : {}),
        });
        setSelectedEventId(ev.id);
        setSelectedPosition(null);
        refresh();
      } catch {
        toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
      } finally {
        setCreating(false);
      }
    },
    [
      projectId,
      creating,
      t,
      refresh,
      setSelectedEventId,
      setSelectedPosition,
      defaultCreateDay,
    ],
  );

  const handleDeleteById = useCallback(
    async (id: string) => {
      if (!projectId) return;
      try {
        await uiDeleteEvent(id);
        if (useChronicleStore.getState().selectedEventId === id)
          setSelectedEventId(null);
        refresh();
      } catch {
        toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
      }
    },
    [projectId, refresh, setSelectedEventId, t],
  );

  // 範囲選択(Shift)用の時間順 id 列（startDay 昇順, 同値は id）。
  const timeOrderedIds = useMemo(
    () =>
      events
        .map((e) => ({ id: e.id, d: eff.byId.get(e.id)?.startDay ?? 0 }))
        .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((x) => x.id),
    [events, eff],
  );

  // 出来事クリック。修飾なし=単一選択（＋位置の縦ライン）, Ctrl/⌘=トグル, Shift=範囲。
  const handleSelectEvent = useCallback(
    (id: string, mods?: { toggle: boolean; range: boolean }) => {
      if (mods?.toggle || mods?.range) {
        const st = useChronicleStore.getState();
        const { ids, primary } = nextSelection(st, id, mods, timeOrderedIds);
        setSelection(ids, primary);
        return;
      }
      // 単一選択（＋開始位置に縦ライン）。
      setSelectedEventId(id);
      const e = events.find((x) => x.id === id);
      setSelectedPosition(
        e && e.startTime != null ? e.startTime : null,
        e?.primaryCodexId ?? null,
      );
    },
    [
      events,
      timeOrderedIds,
      setSelection,
      setSelectedEventId,
      setSelectedPosition,
    ],
  );

  // 空白クリックで位置選択（出来事選択は外す）。
  const handleSelectPosition = useCallback(
    (day: number | null, codexId: string | null) => {
      setSelectedEventId(null);
      setSelectedPosition(day, codexId);
    },
    [setSelectedEventId, setSelectedPosition],
  );

  // 「レーンを追加」: 空の未割当レーンを 1 本増やす（複数可）。出来事を入れると
  // その laneGroup が DB に焼かれて永続。空のままなら emptyGroups(セッション)に留まる。
  const handleAddLane = useCallback(() => {
    const id = `g${groupCounterRef.current++}`;
    setEmptyGroups((g) => [...g, id]);
  }, []);
  // 空の未割当レーン（× ボタン）を畳む。出来事が入っている群は呼ばれない。
  const handleHideGroup = useCallback((groupId: string) => {
    setEmptyGroups((g) => g.filter((x) => x !== groupId));
  }, []);

  // 未割当レーンのピッカーで群ごと Codex へ割り当てる（その群の未割当出来事を一括）。
  // groupId=null は基底未割当（laneGroup 無し）の出来事すべてが対象。
  const handleAssignGroup = useCallback(
    async (groupId: string | null, codexId: string) => {
      if (!projectId || !codexId) return;
      const targets = events.filter((e) => {
        const assigned =
          e.primaryCodexId && entries.some((x) => x.id === e.primaryCodexId);
        if (assigned) return false;
        const g = e.laneGroup && e.laneGroup.length ? e.laneGroup : null;
        return groupId == null ? g == null : g === groupId;
      });
      try {
        for (const e of targets) {
          await uiUpdateEvent({
            eventId: e.id,
            primaryCodexId: codexId,
            laneGroup: "",
          });
        }
        if (groupId) handleHideGroup(groupId);
        refresh();
      } catch {
        toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
      }
    },
    [projectId, events, entries, handleHideGroup, refresh, t],
  );

  // ── 複数選択の一括操作（multiCount>1 のとき下部バーに表示） ──
  const clearSelection = useCallback(
    () => setSelectedEventId(null),
    [setSelectedEventId],
  );

  // 選択中をまとめて削除。
  const handleBulkDelete = useCallback(async () => {
    if (!projectId || selectedIdSet.size === 0) return;
    try {
      for (const id of selectedIdSet) await uiDeleteEvent(id);
      setSelectedEventId(null);
      refresh();
    } catch {
      toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
    }
  }, [projectId, selectedIdSet, setSelectedEventId, refresh, t]);

  // 選択中をまとめて指定 Codex レーンへ割当（""=未割当へ戻す）。
  const handleBulkAssign = useCallback(
    async (codexId: string) => {
      if (!projectId || selectedIdSet.size === 0) return;
      try {
        for (const id of selectedIdSet)
          await uiUpdateEvent({
            eventId: id,
            primaryCodexId: codexId,
            laneGroup: "",
          });
        refresh();
      } catch {
        toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
      }
    },
    [projectId, selectedIdSet, refresh, t],
  );

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

  // 選択中イベントの参加レーン（複数 Codex 所属）。
  const selectedParticipants = useMemo(
    () => (selected ? (participantsByEvent.get(selected.id) ?? []) : []),
    [selected, participantsByEvent],
  );
  const handleSetParticipants = useCallback(
    async (codexEntryIds: string[]) => {
      if (!selected || !projectId) return;
      try {
        await uiSetEventParticipants(selected.id, codexEntryIds);
        refresh();
      } catch {
        toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
      }
    },
    [selected, projectId, refresh, t],
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

  // ── ステータスバー（縦ライン位置＝ルーラー解像度依存 / 選択イベント開始終了＝設定解像度依存）──
  const rulerLevel = layout.ticks.level;
  const lineGran =
    rulerLevel === "year"
      ? "year"
      : rulerLevel === "month"
        ? "month"
        : rulerLevel === "hour" || rulerLevel === "minute"
          ? "time"
          : "day";
  const linePosLabel =
    selectedDay != null && eff.hasCalendarAxis
      ? formatChronicleDate(selectedDay, 0, lineGran, cal, lang)
      : null;
  const selStartLabel =
    selected && selected.startGranularity !== "none"
      ? formatChronicleDate(
          selected.startTime,
          selected.startMinute,
          selected.startGranularity,
          cal,
          lang,
        )
      : null;
  const selEndLabel =
    selected && selected.endTime != null
      ? formatChronicleDate(
          selected.endTime,
          selected.endMinute,
          selected.endGranularity === "none" ? "day" : selected.endGranularity,
          cal,
          lang,
        )
      : null;
  const showStatusBar =
    n > 0 && !tieMode && (linePosLabel != null || selected != null);

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
        locked={locked}
        calendar={calendar}
        creating={creating}
        onNew={handleAdd}
        onExtract={() => setExtractOpen(true)}
        onSaveCalendar={(c) => void saveCalendar(c)}
        onToggleTie={() => setTieMode((m) => !m)}
        onToggleLock={toggleLock}
        onGotoConflict={handleGotoConflict}
        onToggleEdges={() => setShowEdges((s) => !s)}
        onZoomIn={() => handleZoom(1.5)}
        onZoomOut={() => handleZoom(1 / 1.5)}
        onFit={handleFit}
        onToggleLegend={() => setShowLegend((s) => !s)}
        onSetDensity={setDensity}
        onToggleLabels={() => setLabelsOn((s) => !s)}
      />

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
          selectedIds={selectedIdSet}
          activeLaneKey={activeLaneKey}
          conflictIds={issueIds}
          relatedIds={relatedIds}
          showEdges={showEdges}
          labelsOn={labelsOn}
          onSelectEvent={handleSelectEvent}
          laneOptions={laneOptions}
          locked={locked}
          onAssignGroup={handleAssignGroup}
          onAddLane={handleAddLane}
          onHideGroup={handleHideGroup}
          selectedDay={selectedDay}
          hasCalendarAxis={eff.hasCalendarAxis}
          onMoveEvent={handleMoveEvent}
          onResizeEvent={handleResizeEvent}
          onCreateEdge={handleCreateEdge}
          onCreateAt={handleCreateAt}
          onSelectPosition={handleSelectPosition}
          onDeleteEvent={handleDeleteById}
        />
      )}

      {showStatusBar && (
        <div
          data-testid="chronicle-status-bar"
          className="flex h-7 flex-none items-center gap-4 border-t border-border bg-muted/20 px-3.5 text-[11px] text-muted-foreground"
          style={{ fontFeatureSettings: "'tnum'" }}
        >
          {linePosLabel != null && (
            <span>
              {t("chronicle.statusLine", "位置")}: {linePosLabel}
            </span>
          )}
          {selStartLabel != null && (
            <span>
              {t("chronicle.statusEvent", "選択")}: {selStartLabel}
              {selEndLabel != null ? ` 〜 ${selEndLabel}` : ""}
            </span>
          )}
        </div>
      )}

      {multiCount > 1 ? (
        <div className="flex h-[60px] flex-none items-center gap-2.5 border-t border-border bg-card px-4.5">
          <span className="text-[13px] font-medium text-foreground">
            {t("chronicle.multiSelected", "{{count}} 件を選択中", {
              count: multiCount,
            })}
          </span>
          <div className="w-56">
            <CodexEntryPicker
              value={null}
              options={laneOptions.map((o) => ({ id: o.id, name: o.name }))}
              onChange={(id) => {
                if (id) void handleBulkAssign(id);
              }}
              ariaLabel={t("chronicle.assignLane", "レーンへ割当")}
              placeholder={t("chronicle.bulkAssignLane", "レーンへ一括割当")}
            />
          </div>
          <button
            type="button"
            onClick={() => void handleBulkAssign("")}
            className="inline-flex h-8 items-center rounded-lg px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {t("chronicle.bulkUnassign", "未割当へ")}
          </button>
          <button
            type="button"
            onClick={() => void handleBulkDelete()}
            className="inline-flex h-8 items-center gap-1 rounded-lg px-3 text-xs text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="size-3.5" /> {t("chronicle.bulkDelete", "削除")}
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="ms-auto inline-flex h-8 items-center gap-1 rounded-lg px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />{" "}
            {t("chronicle.clearSelection", "選択解除")}
          </button>
        </div>
      ) : selected ? (
        <ChronicleInspector
          event={selected}
          height={inspectorHeight}
          onHeightChange={setInspectorHeight}
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
          participantIds={selectedParticipants}
          onSetParticipants={handleSetParticipants}
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
