import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Trash2, X } from "lucide-react";
import { PanelHeader } from "@/features/layout/PanelHeader";
import { useProjectStore } from "@/features/project/projectStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useTimelineStore } from "@/features/timeline/timelineStore";
import {
  createChronicleEvent,
  deleteChronicleItem,
  patchChronicleItem,
  type ChronicleCommandPorts,
} from "@/application/chronicle/chronicleCommands";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import { useChronicleStore } from "./chronicleStore";
import type { EventRow } from "./api";
// 手動 CRUD は tracked-write（undo/Linter 連動・surface="manual"）経由で書き込む。
import {
  uiCreateEvent,
  uiUpdateEvent,
  uiDeleteEvent,
  uiAddEventRelation,
  uiRemoveEventRelation,
  uiSetEventParticipants,
  uiLinkSceneEvent,
  uiUnlinkSceneEvent,
} from "@/features/agent-writes/event";
import {
  deriveSceneEventRows,
  isSceneEventId,
  sceneIdFromEventId,
} from "./sceneEventAdapter";
import type { SceneLinkMode } from "./SceneLinkField";
import { directCauses, directEffects } from "./causalTraversal";
import { findCausalityConflicts, causalIssueEventIds } from "./eventCausality";
import { findTwoPlacesConflicts, twoPlacesEventIds } from "./twoPlaces";
import { effectiveDays } from "./chronicleAxis";
import {
  buildChronicleWorldGeometry,
  projectChronicleWorldGeometry,
  causalConflictPairSet,
  laneDupId,
  decodeLaneTarget,
  GROUP_PREFIX,
  type LaneDensity,
  type LayoutEventInput,
  type LayoutLane,
} from "./chronicleLayout";
import { nextSelection } from "./chronicleSelection";
import {
  loadLaneOrder,
  saveLaneOrder,
  orderIndexMap,
  compareByLaneOrder,
  mergeLaneOrder,
} from "./chronicleLaneOrder";
import { formatChronicleDate } from "./chronicleTime";
import type { ChronicleCalendar, DateLang } from "./chronicleTime";
import { createEditorInstanceId } from "@/features/editor/document/documentKey";
import { announcePersistedBinding } from "@/features/editor/editorSaveRegistry";
import { MIN_PER_DAY, splitDayMinute, shiftEventPatch } from "./chronicleShift";
import type { MarkerEvent } from "./EventMarker";
import { ChronicleViewport } from "./ChronicleViewport";
import { ChronicleToolbar } from "./ChronicleToolbar";
import { ChronicleInspector } from "./ChronicleInspector";
import {
  ChronicleEventList,
  type ChronicleEventListItem,
} from "./ChronicleEventList";
import { CodexEntryPicker } from "./CodexEntryPicker";
import { ChronicleExtractDialog } from "./ChronicleExtractDialog";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import { useSeasonConflicts } from "./useSeasonConflicts";
import { useChronicleQuery } from "./useChronicleQuery";
import { useChronicleViewportController } from "./useChronicleViewportController";
import { announce } from "@/lib/a11y/announcer";
import { trackPendingEditorWrite } from "@/lib/editorQuiescence";
import { AlreadyNotifiedSaveError } from "@/hooks/useAutoSave";
import {
  externalDocumentStateKey,
  useExternalWriteStore,
} from "@/features/concurrency/externalWriteStore";
import type { SlotPanelProps } from "@/features/layout/layoutTypes";

type EventAggregateWriteResult = { version: number };

function rollbackOptimisticEventPatch(
  current: EventRow,
  before: EventRow,
  patch: Partial<EventRow>,
): EventRow {
  const restored = { ...current };
  for (const rawKey of Object.keys(patch)) {
    const key = rawKey as keyof EventRow;
    // A newer optimistic edit of the same field wins. Only restore the value
    // installed by this failed write.
    if (Object.is(current[key], patch[key])) {
      Object.assign(restored, { [key]: before[key] });
    }
  }
  // A failed older write must never move the aggregate version behind a
  // successful write that completed while it was pending.
  restored.version = Math.max(current.version, before.version);
  return restored;
}

/**
 * 作中年表(Chronicle)パネル — 人物/場所レーン×作中時間軸の pan/zoom 年表。
 * 座標数学は chronicleAxis/Ticks/LanePack/CausalBezier（純関数）に委譲し、
 * 本コンポーネントはデータロード・状態・CRUD と各サブビューの配線を担う。
 */
export function ChroniclePanel({ isActive = true }: SlotPanelProps = {}) {
  const { t, i18n } = useTranslation();
  const lang: DateLang = i18n.language?.startsWith("en") ? "en" : "ja";
  const projectId = useProjectStore((s) => s.currentProjectId);
  const entries = useCodexStore((s) => s.entries);
  const selectedEventId = useChronicleStore((s) => s.selectedEventId);
  const selectedEventIds = useChronicleStore((s) => s.selectedEventIds);
  const setSelectedEventId = useChronicleStore((s) => s.setSelectedEventId);
  const setSelection = useChronicleStore((s) => s.setSelection);
  const locked = useChronicleStore((s) => s.locked);
  const toggleLock = useChronicleStore((s) => s.toggleLock);
  const selectedDay = useChronicleStore((s) => s.selectedDay);
  const setSelectedPosition = useChronicleStore((s) => s.setSelectedPosition);
  // 年表 mutation/undo/redo で単調増加。これを load effect の依存に入れることで
  // Undo/Redo（bumpRevision のみ呼ぶ）後も DB から再取得して表示を更新する。
  const revisionCounter = useChronicleStore((s) => s.revisionCounter);
  const updateStoryTime = useTreeStore((s) => s.updateStoryTime);
  const nodes = useTreeStore((s) => s.nodes);
  // Scene-Event union の書き戻し（scene-event 編集 → シーン側プロパティ）に使う。
  const updateNodeTitle = useTreeStore((s) => s.updateNodeTitle);
  const updateSynopsis = useTreeStore((s) => s.updateSynopsis);
  const updatePovCharacter = useTreeStore((s) => s.updatePovCharacter);
  const updateLocation = useTreeStore((s) => s.updateLocation);
  const updateChronicleDate = useTreeStore((s) => s.updateChronicleDate);
  const timelineSelected = useTimelineStore((s) => s.selectedNodeIds);
  const documentVersionOriginRef = useRef(
    createEditorInstanceId("chronicle-panel"),
  );
  const eventVersionProjectRef = useRef<string | null>(projectId);
  const eventVersionsRef = useRef(new Map<string, number>());
  const eventWriteChainsRef = useRef(new Map<string, Promise<unknown>>());

  if (eventVersionProjectRef.current !== projectId) {
    eventVersionProjectRef.current = projectId;
    eventVersionsRef.current.clear();
  }

  /**
   * EventRow と participants は同じ Event aggregate version を共有する。
   * 同一 event の書き込みを直列化し、各ジョブは実行直前の latest version を使う。
   */
  const enqueueEventAggregateWrite = useCallback(
    <T extends EventAggregateWriteResult>(
      eventId: string,
      suggestedBaseVersion: number | undefined,
      write: (baseVersion: number) => Promise<T>,
    ): Promise<T> => {
      const writeProjectId = projectId;
      const chainKey = `${writeProjectId ?? ""}\u0000${eventId}`;
      const previous =
        eventWriteChainsRef.current.get(chainKey) ?? Promise.resolve();
      const run = previous
        .catch(() => undefined)
        .then(async () => {
          const knownVersion = eventVersionsRef.current.get(eventId);
          const baseVersion =
            knownVersion === undefined
              ? suggestedBaseVersion
              : suggestedBaseVersion === undefined
                ? knownVersion
                : Math.max(knownVersion, suggestedBaseVersion);
          if (baseVersion === undefined) {
            throw new Error(`Event version is unavailable: ${eventId}`);
          }
          const result = await write(baseVersion);
          if (eventVersionProjectRef.current === writeProjectId) {
            eventVersionsRef.current.set(
              eventId,
              Math.max(
                eventVersionsRef.current.get(eventId) ?? baseVersion,
                result.version,
              ),
            );
          }
          return result;
        });
      trackPendingEditorWrite(run);
      eventWriteChainsRef.current.set(chainKey, run);
      void run
        .finally(() => {
          if (eventWriteChainsRef.current.get(chainKey) === run) {
            eventWriteChainsRef.current.delete(chainKey);
          }
        })
        .catch(() => {
          // The caller owns persistence failure handling.
        });
      return run;
    },
    [projectId],
  );

  const chronicleCommandPorts = useMemo<ChronicleCommandPorts>(
    () => ({
      event: {
        create: (input) => uiCreateEvent(input),
        update: (input) =>
          enqueueEventAggregateWrite(
            input.eventId,
            input.baseVersion,
            async (baseVersion) => {
              const result = await uiUpdateEvent(
                {
                  ...(input as Parameters<typeof uiUpdateEvent>[0]),
                  baseVersion,
                },
                { suppressDocumentNotification: true },
              );
              announcePersistedBinding(
                { kind: "chronicle-event", id: input.eventId },
                documentVersionOriginRef.current,
                {
                  kind: "chronicle-event",
                  id: input.eventId,
                  loadedVersion: result.version,
                },
              );
              return result;
            },
          ),
        delete: (eventId, options) =>
          enqueueEventAggregateWrite(
            eventId,
            options?.baseVersion,
            (baseVersion) => uiDeleteEvent(eventId, { baseVersion }),
          ),
        addRelation: uiAddEventRelation,
        removeRelation: uiRemoveEventRelation,
        setParticipants: (eventId, codexEntryIds, options) =>
          enqueueEventAggregateWrite(
            eventId,
            options?.baseVersion,
            async (baseVersion) => {
              const result = await uiSetEventParticipants(
                eventId,
                codexEntryIds,
                {
                  ...options,
                  baseVersion,
                  suppressDocumentNotification: true,
                },
              );
              announcePersistedBinding(
                { kind: "chronicle-event", id: eventId },
                documentVersionOriginRef.current,
                {
                  kind: "chronicle-event",
                  id: eventId,
                  loadedVersion: result.version,
                },
              );
              return result;
            },
          ),
        linkScene: uiLinkSceneEvent,
        unlinkScene: uiUnlinkSceneEvent,
      },
      scene: {
        updateTitle: updateNodeTitle,
        updateSynopsis,
        updatePov: updatePovCharacter,
        updateLocation,
        updateDate: updateChronicleDate,
      },
    }),
    [
      enqueueEventAggregateWrite,
      updateNodeTitle,
      updateSynopsis,
      updatePovCharacter,
      updateLocation,
      updateChronicleDate,
    ],
  );

  const [reloadKey, setReloadKey] = useState(0);
  const resetViewportForProjectRef = useRef<(projectId: string | null) => void>(
    () => undefined,
  );

  const resetProjectTransientState = useCallback(
    (nextProjectId: string | null) => {
      setSelectedEventId(null);
      // 位置選択(ephemeral)も捨てる。残すと handleAdd が他プロジェクトの
      // codexId/日を新規イベントへ書き込みクロスプロジェクト参照を作る。
      setSelectedPosition(null);
      setEmptyGroups([]);
      setLaneOrder([]);
      lastPersistedOrderRef.current = [];
      // 永続ビューがあれば維持（再フィットしない）、無ければ新規プロジェクトに
      // 合わせて全体フィットし直す。
      resetViewportForProjectRef.current(nextProjectId);
    },
    [setSelectedEventId, setSelectedPosition],
  );

  const handleProjectEventsLoaded = useCallback((rows: EventRow[]) => {
    const sceneIds = deriveSceneEventRows(useTreeStore.getState().nodes).map(
      (row) => row.id,
    );
    useChronicleStore
      .getState()
      .sanitizeSelection(
        new Set([...rows.map((event) => event.id), ...sceneIds]),
      );
  }, []);

  const handleProjectLoaded = useCallback(
    (count: number) => {
      announce(
        t("chronicle.a11yLoaded", "年表を読み込みました（{{count}}件）", {
          count,
        }),
      );
    },
    [t],
  );

  const { events, setEvents, sceneLinks, relations, participants } =
    useChronicleQuery({
      projectId,
      reloadKey,
      revisionCounter,
      onProjectChanged: resetProjectTransientState,
      onProjectLoaded: handleProjectLoaded,
      onEventsLoaded: handleProjectEventsLoaded,
    });

  const latestEventsRef = useRef<EventRow[]>(events);
  latestEventsRef.current = events;
  for (const event of events) {
    if (event.projectId !== projectId) continue;
    eventVersionsRef.current.set(
      event.id,
      Math.max(
        eventVersionsRef.current.get(event.id) ?? event.version,
        event.version,
      ),
    );
  }

  const mutateEvents = useCallback(
    (mutate: (current: EventRow[]) => EventRow[]) => {
      const next = mutate(latestEventsRef.current);
      latestEventsRef.current = next;
      setEvents(next);
    },
    [setEvents],
  );

  const patchRealEvent = useCallback(
    async (
      id: string,
      patch: Partial<EventRow>,
      options?: { propagateFailure?: boolean; baseVersion?: number },
    ) => {
      const before = latestEventsRef.current.find((event) => event.id === id);
      if (!before) return;
      mutateEvents((current) =>
        current.map((event) =>
          event.id === id ? { ...event, ...patch } : event,
        ),
      );
      try {
        const result = await patchChronicleItem(
          { kind: "event", id },
          patch,
          chronicleCommandPorts,
          { baseVersion: options?.baseVersion ?? before.version },
        );
        if (result) {
          mutateEvents((current) =>
            current.map((event) =>
              event.id === id
                ? {
                    ...event,
                    version: Math.max(event.version, result.version),
                  }
                : event,
            ),
          );
        }
        return result;
      } catch (error) {
        mutateEvents((current) =>
          current.map((event) =>
            event.id === id
              ? rollbackOptimisticEventPatch(event, before, patch)
              : event,
          ),
        );
        toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
        if (options?.propagateFailure) {
          throw error instanceof AlreadyNotifiedSaveError
            ? error
            : new AlreadyNotifiedSaveError(
                error instanceof Error ? error.message : String(error),
              );
        }
      }
    },
    [chronicleCommandPorts, mutateEvents, t],
  );

  // 表示オプション（ローカル・非永続）。
  const [density, setDensity] = useState<LaneDensity>("standard");
  const [labelsOn, setLabelsOn] = useState(true);
  const [showLegend, setShowLegend] = useState(true);
  const [showEventList, setShowEventList] = useState(false);
  const [showInspector, setShowInspector] = useState(true);
  const [showEdges, setShowEdges] = useState(true);
  const [extractOpen, setExtractOpen] = useState(false);
  // インスペクタ高さ（上端グリップでリサイズ。選択をまたいで保持）。
  const [inspectorWidth, setInspectorWidth] = useState(360);
  // 「レーンを追加」で増やす空の未割当レーン群（id）。出来事を入れると laneGroup で永続。
  const groupCounterRef = useRef(0);
  const [emptyGroups, setEmptyGroups] = useState<string[]>([]);
  // codex レーンの表示順（codexId[]）。per-project に projectSettings で永続。
  const [laneOrder, setLaneOrder] = useState<string[]>([]);
  // ロールバック用に最新 laneOrder を ref で保持（更新子へ副作用を入れない）。
  const laneOrderRef = useRef<string[]>([]);
  laneOrderRef.current = laneOrder;
  // 永続済み（=並べ替え前）の順序。保存失敗時の同期ロールバック先。
  const lastPersistedOrderRef = useRef<string[]>([]);
  // codex 存在判定を dep 汚染なしで読むための ref（並べ替えマージで使う）。
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

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
        // 日時が明示設定済みか（開始時刻あり かつ 粒度 != none）。追加時に
        // イベント優先で上書きすると消えるため、SceneLinkField が確認ダイアログを出す。
        hasDate:
          n.chronicleStartTime != null &&
          (n.chronicleStartGranularity ?? "none") !== "none",
        pos: order.get(n.id) ?? Number.POSITIVE_INFINITY,
      }))
      .sort((a, b) => a.pos - b.pos)
      .map(({ id, title, hasDate }) => ({ id, title, hasDate }));
  }, [nodes]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  // codex レーン順を per-project でロード（projectSettings）。
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void loadLaneOrder(projectId).then((order) => {
      if (!cancelled) {
        setLaneOrder(order);
        lastPersistedOrderRef.current = order;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Scene-Event union: 作中日付を持つシーンを擬似 EventRow 化してタイムラインに
  // 一級トークンとして混ぜる（描画・選択・レイアウト専用）。実 event の `events` は
  // DB 書き込み用に純粋なまま保つ。scene:* id は書き込み経路で isSceneEventId ガードする。
  const sceneEventRows = useMemo(() => deriveSceneEventRows(nodes), [nodes]);
  const renderEvents = useMemo(
    () => [...events, ...sceneEventRows],
    [events, sceneEventRows],
  );

  // 整合チェックの scene 取り込み方針:
  // - 2か所同時 / 年齢 = scene-event も対象（POV人物+場所+日付/本文年齢語を持つため有効）。
  // - 季節（event↔リンクシーン本文モデル）/ 因果（関係を持つ event 前提）= 実 event 専用。
  // 年齢は useSeasonConflicts に ageExtraEvents として scene-event を渡す（本文は自分自身）。
  const {
    calendar,
    conflicts,
    conflictIds,
    ageConflicts,
    ageConflictIds,
    saveCalendar,
  } = useSeasonConflicts({
    projectId,
    events,
    links: sceneLinks,
    ageExtraEvents: sceneEventRows,
  });
  const cal = useMemo<ChronicleCalendar>(
    () => calendar ?? { daysPerYear: 360, seasonBoundaries: [] },
    [calendar],
  );

  const causalConflicts = useMemo(
    () => findCausalityConflicts({ events, relations }),
    [events, relations],
  );
  const twoPlacesConflicts = useMemo(
    () => findTwoPlacesConflicts({ events: renderEvents }),
    [renderEvents],
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

  const eff = useMemo(
    () =>
      effectiveDays(
        renderEvents.map((e) => ({
          id: e.id,
          ordinal: e.ordinal,
          startTime: e.startTime,
          endTime: e.endTime,
          startMinute: e.startMinute,
          endMinute: e.endMinute,
        })),
      ),
    [renderEvents],
  );

  // フィット時の中心日（開始日の中央値）。遠い外れ値でスパンが最小ズームに収まらない
  // ときに、外れ値へ張り付かず主要イベント群を中心に映すために使う。
  const fitFocusDay = useMemo(() => {
    const days = [...eff.byId.values()]
      .map((v) => v.startDay)
      .sort((a, b) => a - b);
    return days.length ? days[Math.floor(days.length / 2)] : 0;
  }, [eff]);
  const viewport = useChronicleViewportController({
    dataStart: eff.dataStart,
    dataEnd: eff.dataEnd,
    eventCount: renderEvents.length,
    focusDay: fitFocusDay,
  });
  resetViewportForProjectRef.current = viewport.resetForProject;
  const { view, trackW, trackElRef, rulerLevelRef, setTrackW, applyView } =
    viewport;

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
    for (const ev of renderEvents) {
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
    // カスタム順(laneOrder)→ 残りは name 昇順。
    const oi = orderIndexMap(laneOrder);
    const ordered = [...laneMap.keys()]
      .map((id) => entryById.get(id)!)
      .sort((a, b) => compareByLaneOrder(a, b, oi));
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
  }, [renderEvents, entries, t, participantsByEvent, emptyGroups, laneOrder]);

  const layoutEvents: LayoutEventInput[] = useMemo(() => {
    const entryIds = new Set(entries.map((e) => e.id));
    return renderEvents.flatMap((e) => {
      const ed = eff.byId.get(e.id);
      if (!ed) return [];
      const base = {
        title: e.title,
        kind: e.kind,
        precision: e.precision,
        secret: e.secret,
        // シーンイベントは常に on-page（scene そのもの）。実 event は scene_events で判定。
        sceneLinked: isSceneEventId(e.id) || scenedEventIds.has(e.id),
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
  }, [renderEvents, entries, eff, scenedEventIds, participantsByEvent]);

  const causalPairs = useMemo(
    () => causalConflictPairSet(causalConflicts),
    [causalConflicts],
  );
  const layoutRelations = useMemo(
    () =>
      relations.map((relation) => ({
        causeId: relation.causeId,
        effectId: relation.effectId,
      })),
    [relations],
  );

  // event/lane/causal geometry is independent from horizontal pan. Zoom still
  // changes pixel widths and lane packing, but viewStartDay only reprojects the
  // already-built world plus the lightweight ruler/scroll geometry.
  const worldLayout = useMemo(
    () =>
      buildChronicleWorldGeometry({
        events: layoutEvents,
        lanes,
        pxPerDay: view.pxPerDay,
        originDay: eff.dataStart,
        density,
        labelsOn,
        relations: layoutRelations,
        causalConflictPairs: causalPairs,
      }),
    [
      layoutEvents,
      lanes,
      view.pxPerDay,
      eff.dataStart,
      density,
      labelsOn,
      layoutRelations,
      causalPairs,
    ],
  );
  const layout = useMemo(
    () =>
      projectChronicleWorldGeometry({
        world: worldLayout,
        view,
        trackW,
        calendar: cal,
        hasCalendarAxis: eff.hasCalendarAxis,
        dataStart: eff.dataStart,
        dataEnd: eff.dataEnd,
        lang,
      }),
    [
      worldLayout,
      view,
      trackW,
      cal,
      eff.hasCalendarAxis,
      eff.dataStart,
      eff.dataEnd,
      lang,
    ],
  );
  rulerLevelRef.current = layout.ticks.level;

  // ドラッグ/期間端伸縮中の日時バブル文言を、現在のルーラー解像度に応じた精度で作る。
  // level → 表示粒度: year/month/day はそのまま、hour/minute は time（HH:MM 付き）。
  // 暦軸なし（order）や粒度なしは空文字＝バブル非表示。
  const formatDragDayLabel = useCallback(
    (day: number): string => {
      if (!eff.hasCalendarAxis) return "";
      const level = layout.ticks.level;
      const gran =
        level === "year"
          ? "year"
          : level === "month"
            ? "month"
            : level === "day"
              ? "day"
              : level === "hour" || level === "minute"
                ? "time"
                : "none";
      if (gran === "none") return "";
      const floorDay = Math.floor(day);
      const minute = Math.round((day - floorDay) * MIN_PER_DAY);
      return formatChronicleDate(floorDay, minute, gran, cal, lang);
    },
    [eff.hasCalendarAxis, layout.ticks.level, cal, lang],
  );

  const eventsById = useMemo(() => {
    const m = new Map<string, MarkerEvent>();
    for (const e of renderEvents) {
      const isScene = isSceneEventId(e.id);
      m.set(e.id, {
        id: e.id,
        title: e.title,
        kind: e.kind,
        precision: e.precision,
        secret: e.secret,
        sceneLinked: isScene || scenedEventIds.has(e.id),
        primaryCodexId: e.primaryCodexId,
        isScene,
      });
    }
    return m;
  }, [renderEvents, scenedEventIds]);

  const selectedFromRows = useMemo(
    () => renderEvents.find((e) => e.id === selectedEventId) ?? null,
    [renderEvents, selectedEventId],
  );
  const selectedSnapshotRef = useRef<EventRow | null>(selectedFromRows);
  if (selectedFromRows) selectedSnapshotRef.current = selectedFromRows;
  const selectedDocumentStateKey =
    selectedEventId === null
      ? null
      : externalDocumentStateKey(
          isSceneEventId(selectedEventId)
            ? {
                kind: "tree",
                id: sceneIdFromEventId(selectedEventId),
                storage: "database",
              }
            : { kind: "chronicle-event", id: selectedEventId },
        );
  const selectedHasExternalConflict = useExternalWriteStore((state) =>
    selectedDocumentStateKey === null
      ? false
      : state.conflicts.some(
          (conflict) =>
            externalDocumentStateKey(
              conflict.documentKey ?? conflict.sceneId,
            ) === selectedDocumentStateKey,
        ),
  );
  const selected =
    selectedFromRows ??
    (selectedHasExternalConflict &&
    selectedSnapshotRef.current?.id === selectedEventId
      ? selectedSnapshotRef.current
      : null);
  const selectedIsScene = selected != null && isSceneEventId(selected.id);

  // 複数選択集合（存在する出来事のみ＝削除済み id を除く）。ハイライト/一括操作に使う。
  const selectedIdSet = useMemo(() => {
    const existing = new Set(renderEvents.map((e) => e.id));
    return new Set(selectedEventIds.filter((id) => existing.has(id)));
  }, [renderEvents, selectedEventIds]);
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
  const { fit: handleFit, zoom: handleZoom, centerOnDay } = viewport;
  const handleGotoConflict = useCallback(() => {
    const ids = [...issueIds];
    if (ids.length === 0) return;
    const id = ids[0];
    setSelectedEventId(id);
    const ed = eff.byId.get(id);
    if (ed) centerOnDay(ed.startDay);
  }, [issueIds, eff, centerOnDay, setSelectedEventId]);

  // 一覧クリック＝ナビゲーション（選択＋当該イベントをビュー中央へ寄せる）。
  // 暦軸/並び順どちらのモードでも ed.startDay へ寄せる（handleGotoConflict と同じ挙動）。
  const handleGotoEvent = useCallback(
    (id: string) => {
      setSelectedEventId(id);
      const ed = eff.byId.get(id);
      if (ed) centerOnDay(ed.startDay);
    },
    [eff, centerOnDay, setSelectedEventId],
  );

  // コンテキスト「原因/結果を選択」: 1 世代上/下（複数可）を選択し先頭へスクロール。
  // ホバー dim（全世代・非選択）とは別で、選択状態に載せる。
  const selectRelatedGeneration = useCallback(
    (eventId: string, dir: "causes" | "effects") => {
      const ids =
        dir === "causes"
          ? directCauses(eventId, relations)
          : directEffects(eventId, relations);
      if (ids.length === 0) return;
      setSelection(ids, ids[0]); // 複数選択（primary=先頭）
      const ed = eff.byId.get(ids[0]);
      if (ed) centerOnDay(ed.startDay);
    },
    [relations, setSelection, eff, centerOnDay],
  );
  const handleSelectCauses = useCallback(
    (eventId: string) => selectRelatedGeneration(eventId, "causes"),
    [selectRelatedGeneration],
  );
  const handleSelectEffects = useCallback(
    (eventId: string) => selectRelatedGeneration(eventId, "effects"),
    [selectRelatedGeneration],
  );

  // サイドペイン一覧の表示用データ（純データに畳んでコンポーネントへ渡す）。
  const laneNameById = useMemo(
    () => new Map(laneOptions.map((o) => [o.id, o.name])),
    [laneOptions],
  );
  const eventListItems = useMemo<ChronicleEventListItem[]>(
    () =>
      events.map((e) => ({
        id: e.id,
        title: e.title,
        kind: e.kind,
        precision: e.precision,
        secret: e.secret,
        isInterval: e.endTime != null,
        primaryCodexId: e.primaryCodexId,
        laneName: e.primaryCodexId
          ? (laneNameById.get(e.primaryCodexId) ?? null)
          : null,
        dateLabel:
          eff.hasCalendarAxis && e.startGranularity !== "none"
            ? formatChronicleDate(
                e.startTime,
                e.startMinute,
                e.startGranularity,
                cal,
                lang,
              )
            : null,
        startDay: eff.byId.get(e.id)?.startDay ?? null,
        hasIssue: issueIds.has(e.id),
      })),
    [events, eff, laneNameById, cal, lang, issueIds],
  );

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
      const ev = await createChronicleEvent(
        {
          title: t("chronicle.newEvent", "新しいイベント"),
          ...(primaryCodexId ? { primaryCodexId } : {}),
          ...(laneGroup ? { laneGroup } : {}),
          ...(day != null
            ? { startTime: Math.round(day), startGranularity: "day" as const }
            : {}),
        },
        chronicleCommandPorts,
      );
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
    chronicleCommandPorts,
  ]);

  // id 指定の楽観パッチ（ドラッグ移動/伸縮/キーボード nudge で使う。handlePatch は選択中専用）。
  const patchById = useCallback(
    async (id: string, patch: Partial<EventRow>) => {
      if (!projectId) return;
      // シーンイベントはシーン側の作中日付/POV へ書き戻す（tree store が楽観 set）。
      const target = isSceneEventId(id)
        ? { kind: "scene" as const, id: sceneIdFromEventId(id) }
        : { kind: "event" as const, id };
      if (target.kind === "scene") {
        try {
          await patchChronicleItem(target, patch, chronicleCommandPorts);
        } catch {
          toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
        }
        return;
      }
      await patchRealEvent(id, patch);
    },
    [projectId, t, chronicleCommandPorts, patchRealEvent],
  );

  // マーカー再配置（横=startTime / 縦=レーン再割当。interval は期間維持）。
  // 時刻 zoom 中は時刻も吸着先へ、日以上 zoom では時刻を保持して day だけ動かす。
  const handleMoveEvent = useCallback(
    (id: string, newStartDay: number | null, newCodexId: string | null) => {
      const e = renderEvents.find((x) => x.id === id);
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
    [renderEvents, patchById],
  );

  // 選択中の全イベントを同じ「日数差分(端数可)」だけ平行移動（レーン・期間長は保持）。
  // deltaDays はズームグリッド由来の端数を含みうる。日グリッド以上(subDay=false)は
  // 差分を整数日へ丸めて一律平行移動する（各イベントの分端数で相対ズレが出るのを防ぐ。
  // 分は保持）。hour/minute ズーム(subDay=true)は端数を分まで反映して平行移動する。
  // キーボード nudge（Alt+←/→）と複数選択の一括ドラッグ移動の共通処理。
  const shiftSelectedBy = useCallback(
    (deltaDays: number) => {
      if (!Number.isFinite(deltaDays) || deltaDays === 0) return;
      const subDay =
        rulerLevelRef.current === "hour" || rulerLevelRef.current === "minute";
      if (!subDay && Math.round(deltaDays) === 0) return;
      for (const id of selectedIdSet) {
        // A rapid key repeat can enqueue another nudge before React rerenders.
        // Real events therefore read the synchronously maintained optimistic
        // snapshot; scene projections continue to use renderEvents.
        const e = isSceneEventId(id)
          ? renderEvents.find((x) => x.id === id)
          : latestEventsRef.current.find((x) => x.id === id);
        if (!e || e.startTime == null) continue;
        void patchById(
          id,
          shiftEventPatch(
            {
              startTime: e.startTime,
              startMinute: e.startMinute,
              endTime: e.endTime,
              endMinute: e.endMinute,
            },
            deltaDays,
            subDay,
          ),
        );
      }
    },
    [selectedIdSet, renderEvents, patchById],
  );

  // 一括ドラッグ: primary の吸着先(newStartDay=グリッド吸着済)と元の先端の差分を全選択へ。
  // 端数(サブデイ/月端数)も保ったまま shiftSelectedBy へ渡す（Math.round しない）。
  const handleMoveSelected = useCallback(
    (primaryId: string, newStartDay: number) => {
      const primary = renderEvents.find((e) => e.id === primaryId);
      if (!primary || primary.startTime == null) return;
      const fracStart =
        primary.startTime + (primary.startMinute ?? 0) / MIN_PER_DAY;
      shiftSelectedBy(newStartDay - fracStart);
    },
    [renderEvents, shiftSelectedBy],
  );

  // 期間端の伸縮（開始/終了を吸着位置へ。start<=end を保つ。時刻 zoom は時刻も更新）。
  const handleResizeEvent = useCallback(
    (id: string, edge: "start" | "end", newDay: number) => {
      const e = renderEvents.find((x) => x.id === id);
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
    [renderEvents, patchById],
  );

  // 期間端伸縮のキーボード代替（Shift+←/→=終了端, Ctrl+Shift=開始端）。プライマリ選択の
  // 期間イベント限定（点はドラッグの端グリップ同様に対象外）。start<=end のクランプと
  // 時刻 zoom 時の分反映は handleResizeEvent が担う。
  const handleResizeSelectedBy = useCallback(
    (edge: "start" | "end", deltaDays: number) => {
      if (!selectedEventId || !Number.isFinite(deltaDays) || deltaDays === 0)
        return;
      const e = renderEvents.find((x) => x.id === selectedEventId);
      if (!e || e.startTime == null || e.endTime == null) return;
      const subDay =
        rulerLevelRef.current === "hour" || rulerLevelRef.current === "minute";
      // 日グリッド以上では分端数を基準に含めない（丸めで端が1日ズレるのを防ぐ）。
      const base =
        edge === "start"
          ? e.startTime + (subDay ? (e.startMinute ?? 0) / MIN_PER_DAY : 0)
          : e.endTime + (subDay ? (e.endMinute ?? 0) / MIN_PER_DAY : 0);
      handleResizeEvent(selectedEventId, edge, base + deltaDays);
    },
    [selectedEventId, renderEvents, handleResizeEvent],
  );

  // D&D 因果エッジ作成（ドラッグ元=原因→落下先=結果）。
  const handleCreateEdge = useCallback(
    async (causeId: string, effectId: string) => {
      // 因果は実 event 専用。scene-event は関係を持てない（Rust 側で弾かれる）。
      if (!projectId || isSceneEventId(causeId) || isSceneEventId(effectId))
        return;
      try {
        await chronicleCommandPorts.event.addRelation(causeId, effectId);
        refresh();
      } catch {
        toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
      }
    },
    [projectId, refresh, t, chronicleCommandPorts],
  );

  // 位置にイベント作成（ダブルクリック/コンテキストメニュー）。
  const handleCreateAt = useCallback(
    async (day: number | null, codexId: string | null) => {
      if (!projectId || creating) return;
      const d = day ?? defaultCreateDay();
      const { primaryCodexId, laneGroup } = decodeLaneTarget(codexId);
      setCreating(true);
      try {
        const ev = await createChronicleEvent(
          {
            title: t("chronicle.newEvent", "新しいイベント"),
            ...(primaryCodexId ? { primaryCodexId } : {}),
            ...(laneGroup ? { laneGroup } : {}),
            ...(d != null
              ? { startTime: Math.round(d), startGranularity: "day" as const }
              : {}),
          },
          chronicleCommandPorts,
        );
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
      chronicleCommandPorts,
    ],
  );

  const handleDeleteById = useCallback(
    async (id: string) => {
      if (!projectId) return;
      try {
        const sceneEvent = isSceneEventId(id);
        const event = sceneEvent
          ? null
          : events.find((candidate) => candidate.id === id);
        if (!sceneEvent && !event) throw new Error(`Event not found: ${id}`);
        await deleteChronicleItem(
          sceneEvent
            ? { kind: "scene", id: sceneIdFromEventId(id) }
            : { kind: "event", id },
          chronicleCommandPorts,
          event ? { baseVersion: event.version } : undefined,
        );
        if (useChronicleStore.getState().selectedEventId === id)
          setSelectedEventId(null);
        refresh();
      } catch {
        toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
      }
    },
    [projectId, events, refresh, setSelectedEventId, t, chronicleCommandPorts],
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

  // コンテキストメニュー「編集」: 単独選択し、詳細パネル(インスペクタ)を必ず開く。
  // トグルで詳細を畳んでいても「編集」なら編集欄が出るよう showInspector を ON にする。
  const handleEditEvent = useCallback(
    (id: string) => {
      setShowInspector(true);
      handleSelectEvent(id);
    },
    [handleSelectEvent],
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

  // codex レーンの並べ替え（ガターの順次入替え）。commit=false はドラッグ中の表示更新
  // （順次入替えの live reorder、永続しない）、commit=true はドロップ時の確定＝永続。
  // mergeLaneOrder で不可視 codex（出来事0 等）の絶対位置を保ちつつ削除済み id を一掃。
  // 保存失敗時は永続済みスナップショットへ同期復帰（DB 再読込せず＝多タブ競合も回避）。
  const handleReorderLanes = useCallback(
    (newOrder: string[], commit: boolean) => {
      const merged = mergeLaneOrder(laneOrderRef.current, newOrder, (id) =>
        entriesRef.current.some((e) => e.id === id),
      );
      setLaneOrder(merged);
      if (commit && projectId) {
        void saveLaneOrder(projectId, merged)
          .then(() => {
            lastPersistedOrderRef.current = merged;
          })
          .catch(() => {
            toast.error(
              t("chronicle.reorderSaveFailed", "レーン順の保存に失敗しました"),
            );
            setLaneOrder(lastPersistedOrderRef.current);
          });
      }
    },
    [projectId, t],
  );

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
        // 対象は互いに独立なので並列に書く（逐次 await で DB を N 回直列に
        // 待たない）。undo journal は 1 件=1 エントリのまま。
        await Promise.all(
          targets.map((e) =>
            patchChronicleItem(
              { kind: "event", id: e.id },
              { primaryCodexId: codexId, laneGroup: "" },
              chronicleCommandPorts,
              { baseVersion: e.version },
            ),
          ),
        );
        if (groupId) handleHideGroup(groupId);
        refresh();
      } catch {
        toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
      }
    },
    [
      projectId,
      events,
      entries,
      handleHideGroup,
      refresh,
      t,
      chronicleCommandPorts,
    ],
  );

  // ── 複数選択の一括操作（multiCount>1 のとき下部バーに表示） ──
  const clearSelection = useCallback(
    () => setSelectedEventId(null),
    [setSelectedEventId],
  );

  // 選択中をまとめて削除。scene-event は作中日付クリア、実 event は削除に振り分ける。
  const handleBulkDelete = useCallback(async () => {
    if (!projectId || selectedIdSet.size === 0) return;
    try {
      // 対象は互いに独立なので並列に消す（undo journal は 1 件=1 エントリのまま）。
      await Promise.all(
        [...selectedIdSet].map((id) => {
          if (isSceneEventId(id)) {
            return deleteChronicleItem(
              { kind: "scene", id: sceneIdFromEventId(id) },
              chronicleCommandPorts,
            );
          }
          const event = events.find((candidate) => candidate.id === id);
          if (!event) throw new Error(`Event not found: ${id}`);
          return deleteChronicleItem(
            { kind: "event", id },
            chronicleCommandPorts,
            { baseVersion: event.version },
          );
        }),
      );
      setSelectedEventId(null);
      refresh();
    } catch {
      toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
    }
  }, [
    projectId,
    selectedIdSet,
    events,
    setSelectedEventId,
    refresh,
    t,
    chronicleCommandPorts,
  ]);

  // 選択中をまとめて指定 Codex レーンへ割当（""=未割当へ戻す）。
  // scene-event はレーン=POV なので updatePovCharacter へ振り分ける。
  const handleBulkAssign = useCallback(
    async (codexId: string) => {
      if (!projectId || selectedIdSet.size === 0) return;
      try {
        // 対象は互いに独立なので並列に書く（undo journal は 1 件=1 エントリのまま）。
        await Promise.all(
          [...selectedIdSet].map((id) => {
            const sceneEvent = isSceneEventId(id);
            return patchChronicleItem(
              sceneEvent
                ? { kind: "scene", id: sceneIdFromEventId(id) }
                : { kind: "event", id },
              sceneEvent
                ? { primaryCodexId: codexId || null }
                : { primaryCodexId: codexId, laneGroup: "" },
              chronicleCommandPorts,
              sceneEvent
                ? undefined
                : {
                    baseVersion: events.find((event) => event.id === id)
                      ?.version,
                  },
            );
          }),
        );
        refresh();
      } catch {
        toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
      }
    },
    [projectId, selectedIdSet, events, refresh, t, chronicleCommandPorts],
  );

  const patchSelected = useCallback(
    async (
      patch: Partial<EventRow>,
      options?: { propagateFailure?: boolean; baseVersion?: number },
    ) => {
      if (!selected || !projectId) return;
      const id = selected.id;
      if (isSceneEventId(id)) {
        try {
          await patchChronicleItem(
            { kind: "scene", id: sceneIdFromEventId(id) },
            patch,
            chronicleCommandPorts,
          );
        } catch (error) {
          toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
          if (options?.propagateFailure) {
            throw error instanceof AlreadyNotifiedSaveError
              ? error
              : new AlreadyNotifiedSaveError(
                  error instanceof Error ? error.message : String(error),
                );
          }
        }
        return;
      }
      return patchRealEvent(id, patch, options);
    },
    [selected, projectId, t, chronicleCommandPorts, patchRealEvent],
  );
  const handlePatch = useCallback(
    async (patch: Partial<EventRow>) => {
      await patchSelected(patch);
    },
    [patchSelected],
  );
  const handlePatchDraft = useCallback(
    async (patch: Partial<EventRow>) => {
      await patchSelected(patch, { propagateFailure: true });
    },
    [patchSelected],
  );
  const handlePatchDetail = useCallback(
    async (detail: string, baseVersion: number) => {
      const result = await patchSelected(
        { detail },
        { propagateFailure: true, baseVersion },
      );
      if (!result) throw new Error("Chronicle detail save returned no version");
      return result;
    },
    [patchSelected],
  );

  const handleDelete = useCallback(async () => {
    if (!selected || !projectId) return;
    try {
      await deleteChronicleItem(
        isSceneEventId(selected.id)
          ? { kind: "scene", id: sceneIdFromEventId(selected.id) }
          : { kind: "event", id: selected.id },
        chronicleCommandPorts,
        isSceneEventId(selected.id)
          ? undefined
          : { baseVersion: selected.version },
      );
      setSelectedEventId(null);
      refresh();
    } catch {
      toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
    }
  }, [
    selected,
    projectId,
    refresh,
    setSelectedEventId,
    t,
    chronicleCommandPorts,
  ]);

  const selectedSceneIds = useMemo(
    () =>
      selected
        ? sceneLinks
            .filter((l) => l.eventId === selected.id)
            .map((l) => l.sceneId)
        : [],
    [selected, sceneLinks],
  );

  // イベント → 開くべきシーン id。scene-event は自分自身、リンク済み実イベントは初出リンク先。
  const sceneIdForEvent = useCallback(
    (eventId: string): string | null => {
      if (isSceneEventId(eventId)) return sceneIdFromEventId(eventId);
      return sceneLinks.find((l) => l.eventId === eventId)?.sceneId ?? null;
    },
    [sceneLinks],
  );
  // 「該当シーンを開く」導線を出せるイベント id 集合（scene-event＋リンク済み実イベント）。
  const openableSceneEventIds = useMemo(() => {
    const s = new Set<string>();
    for (const l of sceneLinks) s.add(l.eventId);
    for (const se of sceneEventRows) s.add(se.id);
    return s;
  }, [sceneLinks, sceneEventRows]);

  // シーンをエディタで開く（ピン留めタブ）。
  const handleOpenScene = useCallback((sceneId: string) => {
    openEditorDocument(
      {
        target: { kind: "scene", documentId: sceneId },
        mode: "pinned",
        revealEditor: true,
        focusEditor: false,
        syncSceneContext: true,
      },
      defaultEditorNavigationPorts,
    );
  }, []);
  const handleOpenSceneForEvent = useCallback(
    (eventId: string) => {
      const sid = sceneIdForEvent(eventId);
      if (sid) handleOpenScene(sid);
    },
    [sceneIdForEvent, handleOpenScene],
  );

  // 選択中イベントに結び付くシーン（scene-event は自分自身 / 実イベントは初出リンク先）。
  const primaryLinkedSceneId = useMemo(
    () => (selected ? sceneIdForEvent(selected.id) : null),
    [selected, sceneIdForEvent],
  );
  // scene 紐付けイベント選択時、Timeline と Chat/エディタの現在シーンも同期する。
  // 自分が Timeline へ同期した scene を覚えておき、選択解除時に取り消す。これを
  // しないと Timeline 選択が残り、その scene に紐づく出来事へ related の薄いリング
  // (box-shadow 3px chronicle-selection 22%) が貼り付いたままになる（選択解除後も残留）。
  const syncedSceneRef = useRef<string | null>(null);
  useEffect(() => {
    const tl = useTimelineStore.getState();
    if (!primaryLinkedSceneId) {
      // 選択解除: 直前に自分が同期した scene だけを解除する。ユーザーが Timeline で
      // 直接選んだ選択（他 id や複数選択）は touch しない（blast radius 最小化）。
      if (
        syncedSceneRef.current &&
        tl.selectedNodeIds.length === 1 &&
        tl.selectedNodeIds[0] === syncedSceneRef.current
      ) {
        tl.clearSelection();
      }
      syncedSceneRef.current = null;
      return;
    }
    tl.selectNode(primaryLinkedSceneId);
    useTreeStore.getState().setActiveScene(primaryLinkedSceneId);
    syncedSceneRef.current = primaryLinkedSceneId;
  }, [primaryLinkedSceneId]);

  const handleStamp = useCallback(async () => {
    if (!selected || isSceneEventId(selected.id)) return;
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
    if (!selected || !projectId || isSceneEventId(selected.id)) return;
    const nodeById = new Map(nodes.map((nd) => [nd.id, nd]));
    const order = selectedSceneIds
      .map((sid) => nodeById.get(sid)?.storyTimeOrder ?? null)
      .find((o): o is string => o != null);
    if (!order) return;
    const id = selected.id;
    await patchRealEvent(id, { ordinal: order });
  }, [selected, projectId, selectedSceneIds, nodes, patchRealEvent]);

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
      if (!selected || !projectId || isSceneEventId(selected.id)) return;
      await chronicleCommandPorts.event.addRelation(causeId, selected.id);
      refresh();
    },
    [selected, projectId, refresh, chronicleCommandPorts],
  );
  const handleRemoveCause = useCallback(
    async (causeId: string) => {
      if (!selected || !projectId || isSceneEventId(selected.id)) return;
      await chronicleCommandPorts.event.removeRelation(causeId, selected.id);
      refresh();
    },
    [selected, projectId, refresh, chronicleCommandPorts],
  );

  const handleLinkScene = useCallback(
    async (sceneId: string, mode: SceneLinkMode = "scene") => {
      // scene:* は events テーブルに行が無く Rust 側 event_ok 検査で弾かれるため不可。
      if (!selected || !projectId || isSceneEventId(selected.id)) return;
      try {
        await chronicleCommandPorts.event.linkScene(sceneId, selected.id);
        // イベント優先: このイベントの日付/POV/場所をシーンへ写して合わせる。
        if (mode === "event") {
          await patchChronicleItem(
            { kind: "scene", id: sceneId },
            {
              startTime: selected.startTime,
              startMinute: selected.startMinute,
              startGranularity: selected.startGranularity,
              endTime: selected.endTime,
              endMinute: selected.endMinute,
              endGranularity: selected.endGranularity,
              precision: selected.precision,
              ...(selected.primaryCodexId
                ? { primaryCodexId: selected.primaryCodexId }
                : {}),
              ...(selected.locationCodexId
                ? { locationCodexId: selected.locationCodexId }
                : {}),
            },
            chronicleCommandPorts,
          );
        }
        refresh();
      } catch {
        toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
      }
    },
    [selected, projectId, refresh, t, chronicleCommandPorts],
  );
  const handleUnlinkScene = useCallback(
    async (sceneId: string) => {
      if (!selected || !projectId || isSceneEventId(selected.id)) return;
      try {
        await chronicleCommandPorts.event.unlinkScene(sceneId, selected.id);
        refresh();
      } catch {
        toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
      }
    },
    [selected, projectId, refresh, t, chronicleCommandPorts],
  );

  // 選択中イベントの参加レーン（複数 Codex 所属）。
  const selectedParticipants = useMemo(
    () => (selected ? (participantsByEvent.get(selected.id) ?? []) : []),
    [selected, participantsByEvent],
  );
  const handleSetParticipants = useCallback(
    async (codexEntryIds: string[]) => {
      if (!selected || !projectId || isSceneEventId(selected.id)) return;
      try {
        const result = await chronicleCommandPorts.event.setParticipants(
          selected.id,
          codexEntryIds,
          { baseVersion: selected.version },
        );
        mutateEvents((current) =>
          current.map((event) =>
            event.id === selected.id
              ? {
                  ...event,
                  version: Math.max(event.version, result.version),
                }
              : event,
          ),
        );
        refresh();
      } catch {
        toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
      }
    },
    [selected, projectId, refresh, mutateEvents, t, chronicleCommandPorts],
  );

  const n = renderEvents.length;

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
  const showStatusBar = n > 0 && (linePosLabel != null || selected != null);

  if (!projectId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t("chronicle.noProject", "プロジェクトを開いてください")}
      </div>
    );
  }

  return (
    <div
      data-testid="chronicle-panel"
      className="flex h-full flex-col overflow-hidden bg-card"
    >
      <PanelHeader
        panelId="chronicle"
        count={t("chronicle.count", "{{count}} 件", { count: n })}
      />

      <ChronicleToolbar
        issueCount={issueCount}
        showLegend={showLegend}
        showEventList={showEventList}
        showInspector={showInspector}
        showEdges={showEdges}
        density={density}
        labelsOn={labelsOn}
        locked={locked}
        calendar={calendar}
        creating={creating}
        onNew={handleAdd}
        onExtract={() => setExtractOpen(true)}
        onSaveCalendar={(c) => void saveCalendar(c)}
        onToggleLock={toggleLock}
        onGotoConflict={handleGotoConflict}
        onToggleEdges={() => setShowEdges((s) => !s)}
        onZoomIn={() => handleZoom(1.5)}
        onZoomOut={() => handleZoom(1 / 1.5)}
        onFit={handleFit}
        onToggleLegend={() => setShowLegend((s) => !s)}
        onToggleEventList={() => setShowEventList((s) => !s)}
        onToggleInspector={() => setShowInspector((s) => !s)}
        onSetDensity={setDensity}
        onToggleLabels={() => setLabelsOn((s) => !s)}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {showEventList && (
          <ChronicleEventList
            items={eventListItems}
            selectedId={selectedEventId}
            laneOptions={laneOptions}
            onSelect={handleGotoEvent}
            onClose={() => setShowEventList(false)}
          />
        )}
        {n === 0 ? (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            {t(
              "chronicle.empty",
              "イベントがまだありません。「追加」で作成できます。",
            )}
          </div>
        ) : (
          <ChronicleViewport
            isActive={isActive}
            view={view}
            onViewChange={applyView}
            onMeasureTrack={setTrackW}
            trackElRef={trackElRef}
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
            onReorderLanes={handleReorderLanes}
            selectedDay={selectedDay}
            hasCalendarAxis={eff.hasCalendarAxis}
            onMoveEvent={handleMoveEvent}
            onResizeEvent={handleResizeEvent}
            onCreateEdge={handleCreateEdge}
            onCreateAt={handleCreateAt}
            onSelectPosition={handleSelectPosition}
            onDeleteEvent={handleDeleteById}
            onEditEvent={handleEditEvent}
            onOpenScene={handleOpenSceneForEvent}
            openableSceneEventIds={openableSceneEventIds}
            relations={relations}
            onSelectCauses={handleSelectCauses}
            onSelectEffects={handleSelectEffects}
            onMoveSelected={handleMoveSelected}
            onNudgeSelected={shiftSelectedBy}
            onResizeSelectedBy={handleResizeSelectedBy}
            onDeleteSelected={handleBulkDelete}
            onClearSelection={clearSelection}
            formatDayLabel={formatDragDayLabel}
          />
        )}
        {showInspector && selected && multiCount <= 1 && (
          <ChronicleInspector
            event={selected}
            width={inspectorWidth}
            onWidthChange={setInspectorWidth}
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
            isScene={selectedIsScene}
            linkedSceneCount={selectedSceneIds.length}
            linkedSceneIds={selectedSceneIds}
            onLinkScene={handleLinkScene}
            onUnlinkScene={handleUnlinkScene}
            onOpenScene={
              primaryLinkedSceneId
                ? () => handleOpenScene(primaryLinkedSceneId)
                : undefined
            }
            onOpenSceneById={handleOpenScene}
            allEvents={events}
            causeIds={selectedCauseIds}
            participantIds={selectedParticipants}
            onSetParticipants={handleSetParticipants}
            onAddCause={handleAddCause}
            onRemoveCause={handleRemoveCause}
            onStamp={handleStamp}
            onPull={handlePull}
            onPatch={handlePatch}
            onPatchDraft={handlePatchDraft}
            onPatchDetail={handlePatchDetail}
            onResolveExternalVersion={(version) => {
              eventVersionsRef.current.set(
                selected.id,
                Math.max(
                  eventVersionsRef.current.get(selected.id) ?? selected.version,
                  version,
                ),
              );
            }}
            onDelete={handleDelete}
            onClose={() => setSelectedEventId(null)}
            lang={lang}
          />
        )}
      </div>

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

      {multiCount > 1 && (
        <div className="flex h-[60px] flex-none items-center gap-2.5 border-t border-border px-4.5">
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
            data-testid="bulk-unassign"
            onClick={() => void handleBulkAssign("")}
            className="inline-flex h-8 items-center rounded-lg px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {t("chronicle.bulkUnassign", "未割当へ")}
          </button>
          <button
            type="button"
            data-testid="bulk-delete"
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
      )}

      <ChronicleExtractDialog
        open={extractOpen}
        onOpenChange={setExtractOpen}
        onImported={refresh}
      />
    </div>
  );
}
