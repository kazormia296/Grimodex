import type {
  EventGranularity,
  EventKind,
  EventPrecision,
} from "../../db/schema.js";
import type {
  CalendarRow,
  EventRelationRow,
  EventRow,
  ParticipantRow,
  SceneEventRow,
} from "./eventRows.js";

/**
 * The read side of the chronicle rows (Mastra migration MP-4b PR-7a): the
 * normalizers of an event, a participant, a scene-event bridge, an event
 * relation and the project calendar. They were private to the renderer's
 * `chronicle/api.ts` (inline in each read function); the bodies are unchanged.
 * `api.ts` imports (and re-exports `normalizeEvent`) them, and the shared core's
 * readers (`core/chronicleReaders.ts`) use the same ones. Nothing here reads a
 * database: no Drizzle, no store, no `invoke`.
 *
 * Each normalizer takes a Drizzle row (camelCase) or a raw row (snake_case).
 */

function s(v: unknown, fallback = ""): string {
  return v == null ? fallback : String(v);
}
function nullableStr(v: unknown): string | null {
  return v == null ? null : String(v);
}
function nullableNum(v: unknown): number | null {
  return v == null ? null : Number(v);
}
/** DB 整数(0/1)・boolean・文字列("1"/"true") いずれの secret 表現も真偽へ正規化。 */
function boolFrom(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v === "1" || v.toLowerCase() === "true";
  return false;
}

/** DB 行（snake_case）/ invoke 戻り値（camelCase）双方を EventRow へ正規化。 */
export function normalizeEvent(raw: unknown): EventRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: s(r.id),
    projectId: s(r.projectId ?? r.project_id),
    title: s(r.title),
    note: nullableStr(r.note),
    detail: nullableStr(r.detail),
    ordinal: s(r.ordinal, "a0"),
    primaryCodexId: nullableStr(r.primaryCodexId ?? r.primary_codex_id),
    laneGroup: nullableStr(r.laneGroup ?? r.lane_group),
    locationCodexId: nullableStr(r.locationCodexId ?? r.location_codex_id),
    startTime: nullableNum(r.startTime ?? r.start_time),
    endTime: nullableNum(r.endTime ?? r.end_time),
    startMinute: nullableNum(r.startMinute ?? r.start_minute),
    endMinute: nullableNum(r.endMinute ?? r.end_minute),
    startGranularity: s(
      r.startGranularity ?? r.start_granularity,
      "none",
    ) as EventGranularity,
    endGranularity: s(
      r.endGranularity ?? r.end_granularity,
      "none",
    ) as EventGranularity,
    precision: s(r.precision, "exact") as EventPrecision,
    kind: s(r.kind, "generic") as EventKind,
    secret: boolFrom(r.secret),
    revealSceneId: nullableStr(r.revealSceneId ?? r.reveal_scene_id),
    version: Number(r.version ?? 0),
    createdAt: s(r.createdAt ?? r.created_at),
    updatedAt: s(r.updatedAt ?? r.updated_at),
  };
}

/**
 * `normalizeEvent` for Main's read path, which fails closed on the two columns
 * that decide what the AI may see (DR-MP4-37). `normalizeEvent` turns a missing,
 * null or unexpected `secret` into `false` (public) and a missing
 * `revealSceneId` into `null`; a reader that dropped either column (a projection,
 * an alias that does not match) would then publish every secret event, with no
 * type error and no failing test. Here a row whose `secret` is not a boolean (or
 * the integer 0/1), or whose `revealSceneId` is not a string or null (an absent
 * key is `undefined`), is an error and not a row.
 *
 * What this cannot see: Drizzle's `integer(..., { mode: "boolean" })` maps the
 * stored value with `Number(v) === 1` before the row reaches here (a null is not
 * mapped and reaches here as null, which this throws on; so does an undefined
 * `revealSceneId`, but an undefined `secret` is mapped to `false` too). So a stored
 * 2 is already `false`, and a stored text is `true` only for '1' (any other text,
 * 'true' and 'x' included, is `false`). That is the renderer's reading of the
 * column too, and it is not changed here.
 */
export function normalizeEventFailClosed(raw: unknown): EventRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  const secret = r.secret;
  if (!(typeof secret === "boolean" || secret === 0 || secret === 1)) {
    throw new Error("chronicle events: the row has no usable `secret` column");
  }
  const reveal = "revealSceneId" in r ? r.revealSceneId : r.reveal_scene_id;
  if (!(reveal === null || typeof reveal === "string")) {
    throw new Error(
      "chronicle events: the row has no usable `revealSceneId` column",
    );
  }
  return normalizeEvent(raw);
}

export function normalizeParticipantRow(raw: unknown): ParticipantRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    eventId: s(r.eventId ?? r.event_id),
    codexEntryId: s(r.codexEntryId ?? r.codex_entry_id),
    role: nullableStr(r.role),
  };
}

export function normalizeSceneEventRow(raw: unknown): SceneEventRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    sceneId: s(r.sceneId ?? r.scene_id),
    eventId: s(r.eventId ?? r.event_id),
  };
}

export function normalizeEventRelationRow(raw: unknown): EventRelationRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    causeId: s(r.causeEventId ?? r.cause_event_id),
    effectId: s(r.effectEventId ?? r.effect_event_id),
  };
}

export function normalizeCalendarRow(raw: unknown): CalendarRow {
  const r = raw as Record<string, unknown>;
  return {
    projectId: s(r.projectId ?? r.project_id),
    daysPerYear: Number(r.daysPerYear ?? r.days_per_year ?? 360),
    seasonBoundaries: s(r.seasonBoundaries ?? r.season_boundaries, "[]"),
    startYear: Number(r.startYear ?? r.start_year ?? 0),
    months: s(r.months, "[]"),
    weekdayNames: s(r.weekdayNames ?? r.weekday_names, "[]"),
    weekdayStartIndex: Number(
      r.weekdayStartIndex ?? r.weekday_start_index ?? 0,
    ),
    leapRule: s(r.leapRule ?? r.leap_rule, '{"kind":"none"}'),
    ageReckoning: s(r.ageReckoning ?? r.age_reckoning, "full"),
    eras: s(r.eras, "[]"),
    reform: s(r.reform, "null"),
    timezone: s(r.timezone, "null"),
    lunarTzMinutes: Number(r.lunarTzMinutes ?? r.lunar_tz_minutes ?? 480),
    version: Number(r.version ?? 0),
    createdAt: s(r.createdAt ?? r.created_at),
    updatedAt: s(r.updatedAt ?? r.updated_at),
  };
}
