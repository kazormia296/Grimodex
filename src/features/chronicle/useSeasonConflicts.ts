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

interface UseSeasonConflictsArgs {
  projectId: string | null;
  events: {
    id: string;
    startTime: number | null;
    primaryCodexId: string | null;
    kind: string;
  }[];
  links: { sceneId: string; eventId: string }[];
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
    const checkable = new Set(
      events.filter((e) => e.startTime != null).map((e) => e.id),
    );
    const sceneIds = [
      ...new Set(
        links.filter((l) => checkable.has(l.eventId)).map((l) => l.sceneId),
      ),
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
        setConflicts(
          findSeasonConflicts({ events, calendar, links, sceneTexts }),
        );
        setAgeConflicts(
          findAgeConflicts({ events, calendar, links, sceneTexts }),
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
  }, [calendar, events, links]);

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
