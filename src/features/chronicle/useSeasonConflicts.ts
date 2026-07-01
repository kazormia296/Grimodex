import { useCallback, useEffect, useMemo, useState } from "react";
import { loadSceneContent } from "@/features/tree/api";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
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

/**
 * Promise.allSettled の結果から成功したシーン本文だけを Map に集める純関数。
 * 1 シーンのロード失敗で全警告が消える退行を防ぐ（fail-silent ではなく graceful）。
 */
export function collectFulfilledSceneTexts(
  results: PromiseSettledResult<readonly [string, string]>[],
): Map<string, string> {
  const sceneTexts = new Map<string, string>();
  for (const r of results) {
    if (r.status === "fulfilled") sceneTexts.set(r.value[0], r.value[1]);
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

interface EventForCheck {
  id: string;
  startTime: number | null;
  primaryCodexId: string | null;
  kind: string;
}

interface UseSeasonConflictsArgs {
  projectId: string | null;
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
  projectId,
  events,
  links,
  ageExtraEvents,
}: UseSeasonConflictsArgs) {
  const [calendar, setCalendar] = useState<ChronicleCalendar | null>(null);
  const [conflicts, setConflicts] = useState<SeasonConflict[]>([]);
  const [ageConflicts, setAgeConflicts] = useState<AgeConflict[]>([]);
  const [calVersion, setCalVersion] = useState(0);

  useEffect(() => {
    if (!projectId) {
      setCalendar(null);
      return;
    }
    let cancelled = false;
    getProjectCalendar(projectId)
      .then((row) => {
        if (cancelled) return;
        if (!row) {
          setCalendar(null);
          return;
        }
        setCalendar(calendarFromRow(row));
      })
      .catch(() => {
        if (!cancelled) setCalendar(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, calVersion]);

  useEffect(() => {
    // 季節は seasonBoundaries が要るが、年齢は daysPerYear>0 だけで動く。
    if (!calendar || calendar.daysPerYear <= 0) {
      setConflicts([]);
      setAgeConflicts([]);
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
      setConflicts([]);
      setAgeConflicts([]);
      return;
    }
    let cancelled = false;
    // allSettled: 1 シーンのロード失敗で全警告を消さない。成功分だけで判定する。
    Promise.allSettled(
      sceneIds.map(
        async (sid) =>
          [sid, extractPlainText(await loadSceneContent(sid))] as const,
      ),
    )
      .then((results) => {
        if (cancelled) return;
        const sceneTexts = collectFulfilledSceneTexts(results);
        // 季節は実 event のみ（event↔リンクシーン本文モデル）。
        setConflicts(
          findSeasonConflicts({ events, calendar, links, sceneTexts }),
        );
        // 年齢は scene-event も含む（本文=自分自身の暗黙リンク）。
        setAgeConflicts(
          findAgeConflicts({
            events: ageEvents,
            calendar,
            links: ageLinks,
            sceneTexts,
          }),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setConflicts([]);
          setAgeConflicts([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [calendar, events, links, ageExtraEvents]);

  const saveCalendar = useCallback(
    async (cal: ChronicleCalendar) => {
      if (!projectId) return;
      await upsertProjectCalendar({
        projectId,
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
      setCalVersion((v) => v + 1);
    },
    [projectId],
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

  return {
    hasCalendar: !!calendar && calendar.seasonBoundaries.length > 0,
    calendar,
    conflicts,
    conflictIds,
    ageConflicts,
    ageConflictIds,
    ensureDefaultCalendar,
    saveCalendar,
  };
}
