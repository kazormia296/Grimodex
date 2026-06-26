import { useCallback, useEffect, useMemo, useState } from "react";
import { loadSceneContent } from "@/features/tree/api";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import {
  DEFAULT_SEASON_BOUNDARIES,
  type ChronicleCalendar,
  type SeasonBoundary,
} from "./chronicleTime";
import {
  findSeasonConflicts,
  conflictingEventIds,
  type SeasonConflict,
} from "./seasonCheck";
import { getProjectCalendar, upsertProjectCalendar } from "./api";

interface UseSeasonConflictsArgs {
  projectId: string | null;
  events: { id: string; startTime: number | null }[];
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
        let boundaries: SeasonBoundary[];
        try {
          boundaries = JSON.parse(row.seasonBoundaries) as SeasonBoundary[];
        } catch {
          boundaries = [];
        }
        setCalendar({
          daysPerYear: row.daysPerYear,
          seasonBoundaries: boundaries,
        });
      })
      .catch(() => {
        if (!cancelled) setCalendar(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, calVersion]);

  useEffect(() => {
    if (!calendar || calendar.seasonBoundaries.length === 0) {
      setConflicts([]);
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
      return;
    }
    let cancelled = false;
    Promise.all(
      sceneIds.map(
        async (sid) =>
          [sid, extractPlainText(await loadSceneContent(sid))] as const,
      ),
    )
      .then((pairs) => {
        if (cancelled) return;
        setConflicts(
          findSeasonConflicts({
            events,
            calendar,
            links,
            sceneTexts: new Map(pairs),
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setConflicts([]);
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

  return {
    hasCalendar: !!calendar && calendar.seasonBoundaries.length > 0,
    calendar,
    conflicts,
    conflictIds,
    ensureDefaultCalendar,
    saveCalendar,
  };
}
