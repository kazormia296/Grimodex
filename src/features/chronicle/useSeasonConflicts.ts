import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadSceneContents } from "@/features/tree/api";
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
    const { events, links, ageExtraEvents } = checkInputs;
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
    loadSceneContents(sceneIds)
      .then((contents) => {
        if (cancelled) return;
        const sceneTexts = collectLoadedSceneTexts(sceneIds, contents);
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
  }, [calendar, checkInputs]);

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
