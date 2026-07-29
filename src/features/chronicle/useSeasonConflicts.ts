import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadSceneContents } from "@/features/tree/api";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { encodeDocumentKey } from "@/features/editor/document/documentKey";
import { subscribeExternalDocumentReloads } from "@/lib/externalDocumentReloadRegistry";
import { subscribeSceneBodyCommits } from "@/lib/sceneBodyCommitRegistry";
import {
  DEFAULT_SEASON_BOUNDARIES,
  type ChronicleCalendar,
} from "./chronicleTime";
import {
  findSeasonConflicts,
  conflictingEventIds,
  type SeasonConflict,
} from "./seasonCheck";
import {
  findAgeConflicts,
  ageConflictEventIds,
  type AgeConflict,
} from "./ageCheck";
import {
  getProjectCalendar,
  upsertProjectCalendar,
  calendarFromRow,
} from "./api";
import { sceneIdFromEventId } from "./sceneEventAdapter";
import { chronicleScopeKey, type ChronicleScope } from "./chronicleScope";

const CONFLICT_RECHECK_DEBOUNCE_MS = 200;
const EMPTY_SEASON_CONFLICTS: SeasonConflict[] = [];
const EMPTY_AGE_CONFLICTS: AgeConflict[] = [];

/**
 * Batch の返却 Map を整合チェック用 plain text Map に変換する。
 * 存在しない行は単発 loader と同じ空本文として扱い、取得できた他シーンを保つ。
 */
export function collectLoadedSceneTexts(
  sceneIds: readonly string[],
  contents: ReadonlyMap<string, string>,
): Map<string, string> {
  const sceneTexts = new Map<string, string>();
  for (const sceneId of sceneIds) {
    sceneTexts.set(sceneId, extractPlainText(contents.get(sceneId) ?? ""));
  }
  return sceneTexts;
}

/**
 * 年齢チェック用に scene-event を events へ足し、暗黙リンク(scene:<id> ↔ <id>)を張る純関数。
 * scene-event は自分自身の本文を参照シーンとして扱い、本文年齢語 vs POV 算出年齢を検査する。
 * ageExtraEvents 未指定/空なら入力をそのまま返す（季節チェックはこの拡張を使わない）。
 */
export function mergeAgeCheckEvents<E extends { id: string }>(
  events: E[],
  links: { sceneId: string; eventId: string }[],
  ageExtraEvents: E[] | undefined,
): { ageEvents: E[]; ageLinks: { sceneId: string; eventId: string }[] } {
  const extra = ageExtraEvents ?? [];
  if (extra.length === 0) return { ageEvents: events, ageLinks: links };
  return {
    ageEvents: [...events, ...extra],
    ageLinks: [
      ...links,
      ...extra.map((e) => ({
        sceneId: sceneIdFromEventId(e.id),
        eventId: e.id,
      })),
    ],
  };
}

export interface EventForCheck {
  id: string;
  startTime: number | null;
  primaryCodexId: string | null;
  kind: string;
}

/**
 * 整合チェック入力の指紋。季節/年齢チェックが実際に読むフィールド
 * （id / startTime / primaryCodexId / kind とリンク対）だけを畳むため、
 * title 等のテキスト編集や配列 identity の変化（楽観 setEvents / nodes 更新に
 * よる再導出）では変わらない。effect の依存をこれに絞ることで、per-keystroke に
 * 本文 batch SELECT＋再チェックが走るカスケードを防ぐ。
 */
export function checkInputsFingerprint(
  events: EventForCheck[],
  links: { sceneId: string; eventId: string }[],
  ageExtraEvents?: EventForCheck[],
): string {
  const ev = (e: EventForCheck) =>
    `${e.id}\u0000${e.startTime ?? ""}\u0000${e.primaryCodexId ?? ""}\u0000${e.kind}`;
  return [
    events.map(ev).join("\n"),
    links.map((l) => `${l.sceneId}\u0000${l.eventId}`).join("\n"),
    (ageExtraEvents ?? []).map(ev).join("\n"),
  ].join("\u0001");
}

export interface UseSeasonConflictsArgs {
  /** Exact database ownership boundary. projectId alone is not globally unique. */
  scope: ChronicleScope | null;
  /** Hidden/inactive panels keep their last snapshot without issuing DB work. */
  enabled?: boolean;
  events: EventForCheck[];
  links: { sceneId: string; eventId: string }[];
  /**
   * Scene-Event union: 年齢チェックにのみ追加するシーンイベント（id=`scene:<id>`）。
   * 各シーンは自分自身の本文を持つので、暗黙リンク（scene:<id> ↔ <id>）を張って
   * 本文の年齢語 vs POV 人物の算出年齢を検査する。季節チェックには含めない。
   */
  ageExtraEvents?: EventForCheck[];
}

/**
 * 暦をロードし、出来事の時刻季節と参照シーン本文の季節矛盾(冬に蝉)を算出するフック。
 * 暦未設定なら hasCalendar=false（チェックは no-op）。ensureDefaultCalendar で
 * 既定の 360日4季暦を作成できる。
 */
export function useSeasonConflicts({
  scope,
  enabled = true,
  events,
  links,
  ageExtraEvents,
}: UseSeasonConflictsArgs) {
  const scopeKey = scope ? chronicleScopeKey(scope) : null;
  const scopeProjectId = scope?.projectId ?? null;
  const activeScopeKeyRef = useRef(scopeKey);
  activeScopeKeyRef.current = scopeKey;

  const [calendarSnapshot, setCalendarSnapshot] = useState<{
    scopeKey: string | null;
    calendar: ChronicleCalendar | null;
  }>({ scopeKey: null, calendar: null });
  const [conflictSnapshot, setConflictSnapshot] = useState<{
    scopeKey: string | null;
    conflicts: SeasonConflict[];
    ageConflicts: AgeConflict[];
  }>({
    scopeKey: null,
    conflicts: EMPTY_SEASON_CONFLICTS,
    ageConflicts: EMPTY_AGE_CONFLICTS,
  });
  const [conflictLoadState, setConflictLoadState] = useState<{
    scopeKey: string | null;
    status: "idle" | "loading" | "ready" | "error";
    error: Error | null;
  }>({ scopeKey: null, status: "idle", error: null });
  const [calVersion, setCalVersion] = useState(0);
  const [contentRevision, setContentRevision] = useState(0);
  const [checkRevision, setCheckRevision] = useState(0);

  // Snapshot values are exposed only to their exact workspace/open/project
  // scope. A synchronous render after a scope switch can therefore never flash
  // conflicts or a calendar from another database while the new load is pending.
  const calendar =
    scopeKey !== null && calendarSnapshot.scopeKey === scopeKey
      ? calendarSnapshot.calendar
      : null;
  const conflicts =
    scopeKey !== null && conflictSnapshot.scopeKey === scopeKey
      ? conflictSnapshot.conflicts
      : EMPTY_SEASON_CONFLICTS;
  const ageConflicts =
    scopeKey !== null && conflictSnapshot.scopeKey === scopeKey
      ? conflictSnapshot.ageConflicts
      : EMPTY_AGE_CONFLICTS;

  // 指紋が同じ間は同一参照をチェック effect へ渡す。楽観 setEvents や nodes 更新に
  // よる「内容は同じで identity だけ変わる」再導出では effect を再走させない
  // （per-keystroke の本文 SELECT＋再チェック対策）。
  const fingerprint = useMemo(
    () => checkInputsFingerprint(events, links, ageExtraEvents),
    [events, links, ageExtraEvents],
  );
  const stableRef = useRef({
    fingerprint,
    inputs: { events, links, ageExtraEvents },
  });
  if (stableRef.current.fingerprint !== fingerprint) {
    stableRef.current = {
      fingerprint,
      inputs: { events, links, ageExtraEvents },
    };
  }
  const checkInputs = stableRef.current.inputs;

  useEffect(() => {
    if (!enabled || !scopeKey || !scopeProjectId) return;
    const requestScopeKey = scopeKey;
    let cancelled = false;
    getProjectCalendar(scopeProjectId)
      .then((row) => {
        if (cancelled || activeScopeKeyRef.current !== requestScopeKey) {
          return;
        }
        if (!row) {
          setCalendarSnapshot({
            scopeKey: requestScopeKey,
            calendar: null,
          });
          return;
        }
        setCalendarSnapshot({
          scopeKey: requestScopeKey,
          calendar: calendarFromRow(row),
        });
      })
      // Preserve the same-scope last-good calendar. Clearing it here would
      // cascade into clearing otherwise valid conflict markers.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [calVersion, enabled, scopeKey, scopeProjectId]);

  const monitoredSceneIds = useMemo(() => {
    const ids = new Set(checkInputs.links.map((link) => link.sceneId));
    for (const event of checkInputs.ageExtraEvents ?? []) {
      ids.add(sceneIdFromEventId(event.id));
    }
    return [...ids].sort();
  }, [checkInputs]);
  const monitoredSceneFingerprint = monitoredSceneIds.join("\u0000");

  // A regular editor save emits an exact-scope commit publication. External
  // file import already emits the canonical reload nonce consumed by mounted
  // editors; subscribe to that same publication so Chronicle observes both
  // persisted body paths without polling or per-keystroke reads.
  useEffect(() => {
    if (!enabled || !scope || !scopeKey || monitoredSceneIds.length === 0) {
      return;
    }
    const sceneIds = new Set(monitoredSceneIds);
    const externalStateKeys = new Set<string>(
      monitoredSceneIds.flatMap((sceneId) => [
        encodeDocumentKey({
          kind: "tree",
          id: sceneId,
          storage: "database",
        }),
        encodeDocumentKey({
          kind: "tree",
          id: sceneId,
          storage: "file",
        }),
      ]),
    );
    let replayingExternalRegistry = true;
    const unsubscribeExternal = subscribeExternalDocumentReloads((stateKey) => {
      // subscribeExternalDocumentReloads replays current nonce inventory.
      // Initial Chronicle loading already reads the latest DB rows, so only
      // publications after subscription are invalidations.
      if (
        !replayingExternalRegistry &&
        activeScopeKeyRef.current === scopeKey &&
        externalStateKeys.has(stateKey)
      ) {
        setContentRevision((revision) => revision + 1);
      }
    });
    replayingExternalRegistry = false;
    const unsubscribeCommits = subscribeSceneBodyCommits((publication) => {
      if (
        activeScopeKeyRef.current === scopeKey &&
        publication.workspacePath === scope.workspacePath &&
        publication.openRevision === scope.openRevision &&
        publication.projectId === scope.projectId &&
        sceneIds.has(publication.sceneId)
      ) {
        setContentRevision((revision) => revision + 1);
      }
    });
    return () => {
      unsubscribeExternal();
      unsubscribeCommits();
    };
    // monitoredSceneFingerprint is the stable ownership input; the array
    // itself is rebuilt only when the semantic check inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, monitoredSceneFingerprint, scopeKey]);

  useEffect(() => {
    const { events, links, ageExtraEvents } = checkInputs;
    if (!enabled || !scopeKey) return;
    const requestScopeKey = scopeKey;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const publishSuccess = (
      nextConflicts: SeasonConflict[],
      nextAgeConflicts: AgeConflict[],
    ) => {
      if (cancelled || activeScopeKeyRef.current !== requestScopeKey) {
        return;
      }
      setConflictSnapshot({
        scopeKey: requestScopeKey,
        conflicts: nextConflicts,
        ageConflicts: nextAgeConflicts,
      });
      setConflictLoadState({
        scopeKey: requestScopeKey,
        status: "ready",
        error: null,
      });
    };

    // 季節は seasonBoundaries が要るが、年齢は daysPerYear>0 だけで動く。
    if (!calendar || calendar.daysPerYear <= 0) {
      publishSuccess([], []);
      return;
    }
    // 年齢チェック用の拡張集合（scene-event＋暗黙リンク）。季節は実 event のみ。
    const { ageEvents, ageLinks } = mergeAgeCheckEvents(
      events,
      links,
      ageExtraEvents,
    );

    const seasonCheckable = new Set(
      events.filter((e) => e.startTime != null).map((e) => e.id),
    );
    const ageCheckable = new Set(
      ageEvents.filter((e) => e.startTime != null).map((e) => e.id),
    );
    // 本文をロードするシーン = 季節(links) ∪ 年齢(ageLinks) の被参照シーン。
    const sceneIds = [
      ...new Set([
        ...links
          .filter((l) => seasonCheckable.has(l.eventId))
          .map((l) => l.sceneId),
        ...ageLinks
          .filter((l) => ageCheckable.has(l.eventId))
          .map((l) => l.sceneId),
      ]),
    ];
    if (sceneIds.length === 0) {
      publishSuccess([], []);
      return;
    }
    setConflictLoadState({
      scopeKey: requestScopeKey,
      status: "loading",
      error: null,
    });
    timer = setTimeout(() => {
      timer = null;
      loadSceneContents(sceneIds)
        .then((contents) => {
          if (cancelled || activeScopeKeyRef.current !== requestScopeKey) {
            return;
          }
          const sceneTexts = collectLoadedSceneTexts(sceneIds, contents);
          // 季節は実 event のみ（event↔リンクシーン本文モデル）。
          const nextConflicts = findSeasonConflicts({
            events,
            calendar,
            links,
            sceneTexts,
          });
          // 年齢は scene-event も含む（本文=自分自身の暗黙リンク）。
          const nextAgeConflicts = findAgeConflicts({
            events: ageEvents,
            calendar,
            links: ageLinks,
            sceneTexts,
          });
          publishSuccess(nextConflicts, nextAgeConflicts);
        })
        .catch((error: unknown) => {
          if (cancelled || activeScopeKeyRef.current !== requestScopeKey) {
            return;
          }
          // Same-scope failures retain the last successful snapshot. A
          // transient SELECT/bridge failure must not make markers disappear.
          setConflictLoadState({
            scopeKey: requestScopeKey,
            status: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          });
        });
    }, CONFLICT_RECHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [
    calendar,
    checkInputs,
    checkRevision,
    contentRevision,
    enabled,
    scopeKey,
  ]);

  const saveCalendar = useCallback(
    async (cal: ChronicleCalendar) => {
      if (!scopeProjectId || !scopeKey) return;
      const requestScopeKey = scopeKey;
      await upsertProjectCalendar({
        projectId: scopeProjectId,
        daysPerYear: cal.daysPerYear,
        seasonBoundaries: JSON.stringify(cal.seasonBoundaries),
        startYear: cal.startYear ?? 0,
        months: JSON.stringify(cal.months ?? []),
        weekdayNames: JSON.stringify(cal.weekdayNames ?? []),
        weekdayStartIndex: cal.weekdayStartIndex ?? 0,
        leapRule: JSON.stringify(cal.leap ?? { kind: "none" }),
        ageReckoning: cal.ageReckoning ?? "full",
        eras: JSON.stringify(cal.eras ?? []),
        reform: JSON.stringify(cal.reform ?? null),
        timezone: JSON.stringify(cal.timezone ?? null),
        lunarTzMinutes: cal.lunarTzMinutes ?? 480,
      });
      if (activeScopeKeyRef.current === requestScopeKey) {
        setCalVersion((v) => v + 1);
      }
    },
    [scopeKey, scopeProjectId],
  );

  const ensureDefaultCalendar = useCallback(
    () =>
      saveCalendar({
        daysPerYear: 360,
        seasonBoundaries: DEFAULT_SEASON_BOUNDARIES,
      }),
    [saveCalendar],
  );

  const conflictIds = useMemo(
    () => conflictingEventIds(conflicts),
    [conflicts],
  );
  const ageConflictIds = useMemo(
    () => ageConflictEventIds(ageConflicts),
    [ageConflicts],
  );
  const currentLoadState =
    scopeKey !== null && conflictLoadState.scopeKey === scopeKey
      ? conflictLoadState
      : { scopeKey, status: "idle" as const, error: null };
  const retryConflicts = useCallback(() => {
    if (enabled && scopeKey) setCheckRevision((revision) => revision + 1);
  }, [enabled, scopeKey]);

  return {
    hasCalendar: !!calendar && calendar.seasonBoundaries.length > 0,
    calendar,
    conflicts,
    conflictIds,
    ageConflicts,
    ageConflictIds,
    ensureDefaultCalendar,
    saveCalendar,
    conflictStatus: enabled ? currentLoadState.status : "disabled",
    conflictLoadError: currentLoadState.error,
    retryConflicts,
  };
}
