import { db } from "@/db/client";
import { invoke } from "@/lib/tauri";
import {
  events,
  eventParticipants,
  sceneEvents,
  projectCalendar,
  eventRelations,
  treeNodes,
} from "@/db/schema";
import type { EventPrecision, EventKind, EventGranularity } from "@/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { nextEventOrdinal } from "./chronicleTime";
// 暦復元の正本は chronicleTime（純粋モジュール）へ集約。ここでは後方互換の再エクスポート。
export { calendarFromRow } from "./chronicleTime";
import { useChronicleStore } from "./chronicleStore";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { EventVersionConflictError } from "./eventOcc";
import { ProjectCalendarVersionConflictError } from "./calendarOcc";
import {
  agentCreateEvent,
  agentUpdateEvent,
  agentDeleteEvent,
  agentLinkSceneEvent,
  agentUnlinkSceneEvent,
  agentAddEventRelation,
  agentRemoveEventRelation,
  agentSetEventParticipants,
} from "@/features/agent-writes/event";

/**
 * Timelapse record for a chronicle (作中年表) mutation. Uses the SAME `event`
 * domain the Rust AI-write path emits (`agent_writes.rs`) so the human UI path
 * and the AI path land in one timeline — they are disjoint callers, not a
 * double-record. sceneId stays null (events have no scene FK; scene links live
 * in the `sceneEvents` join table).
 */
function recordEvent(
  projectId: string,
  opType: string,
  entityId: string | null,
  payload: Record<string, unknown>,
): void {
  recordChangeEvent({
    domain: "event",
    opType,
    projectId,
    entityType: "event",
    entityId,
    payload,
  });
}

/**
 * 年表 mutation 後に AI コンテキストの鮮度カウンタを上げる（C3 prompt 鮮度）。
 * UI / 抽出ウィザード / 将来の agent・MCP write が全てこの API を通るため、ここを
 * 単一チョークポイントにすれば全経路で contextPromptKey が更新される。
 */
function bumpChronicleRevision(): void {
  useChronicleStore.getState().bumpRevision();
}

/** Human / legacy api 経路の Native writer 呼び出し既定値。 */
function manualApiWriteOpts(projectId: string) {
  return {
    surface: "manual" as const,
    skipPolicyGate: true,
    projectId,
  };
}

function rethrowEventVersionConflict(eventId: string, err: unknown): never {
  if (err instanceof Error && err.message.includes("version conflict")) {
    throw new EventVersionConflictError(eventId);
  }
  throw err;
}

export interface EventRow {
  id: string;
  projectId: string;
  title: string;
  note: string | null;
  /** 出来事の詳細（リッチテキスト = ProseMirror JSON 文字列）。null/空 = 未入力。 */
  detail: string | null;
  ordinal: string;
  primaryCodexId: string | null;
  /** 未割当の整理用サブレーン id（null=既定の未割当レーン）。 */
  laneGroup: string | null;
  locationCodexId: string | null;
  startTime: number | null;
  endTime: number | null;
  startMinute: number | null;
  endMinute: number | null;
  startGranularity: EventGranularity;
  endGranularity: EventGranularity;
  precision: EventPrecision;
  kind: EventKind;
  /** AI 秘匿フラグ（reveal アンカー方式）。true=条件付きで AI 文脈から除外。 */
  secret: boolean;
  /** 読む順の開示アンカー（明示上書き専用）。null=自動導出 or 恒久秘匿。 */
  revealSceneId: string | null;
  /** Aggregate OCC version (event row + participant set). */
  version: number;
  createdAt: string;
  updatedAt: string;
}

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

export async function listEvents(projectId: string): Promise<EventRow[]> {
  // ordinal,id の二段ソートで決定論的な並び（ordinal 重複でもリロード間で順序が
  // 揺れない）を保証する。年表 x 軸順の安定性が下流の座標算出に効く。
  const rows = await db
    .select()
    .from(events)
    .where(eq(events.projectId, projectId))
    .orderBy(asc(events.ordinal), asc(events.id));
  return rows.map(normalizeEvent);
}

/** 単一の出来事を取得（fail-closed: projectId 一致のみ）。EditorPane の詳細ロード用。 */
export async function getEvent(
  projectId: string,
  id: string,
): Promise<EventRow | null> {
  const [row] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, id), eq(events.projectId, projectId)));
  return row ? normalizeEvent(row) : null;
}

export async function createEvent(data: {
  id?: string;
  projectId: string;
  title?: string;
  note?: string | null;
  detail?: string | null;
  ordinal?: string;
  primaryCodexId?: string | null;
  locationCodexId?: string | null;
  startTime?: number | null;
  endTime?: number | null;
  startMinute?: number | null;
  endMinute?: number | null;
  startGranularity?: EventGranularity;
  endGranularity?: EventGranularity;
  precision?: EventPrecision;
  kind?: EventKind;
  secret?: boolean;
  revealSceneId?: string | null;
}): Promise<EventRow> {
  const id = data.id ?? crypto.randomUUID();
  let ordinal = data.ordinal;
  if (ordinal === undefined) {
    const existing = await db
      .select()
      .from(events)
      .where(eq(events.projectId, data.projectId))
      .orderBy(asc(events.ordinal), asc(events.id));
    ordinal = nextEventOrdinal(existing.map((e) => normalizeEvent(e).ordinal));
  }
  await agentCreateEvent(
    {
      eventId: id,
      title: data.title ?? "",
      note: data.note ?? null,
      detail: data.detail ?? null,
      ordinal,
      primaryCodexId: data.primaryCodexId ?? null,
      locationCodexId: data.locationCodexId ?? null,
      startTime: data.startTime ?? null,
      endTime: data.endTime ?? null,
      startMinute: data.startMinute ?? null,
      endMinute: data.endMinute ?? null,
      ...(data.startGranularity !== undefined
        ? { startGranularity: data.startGranularity }
        : {}),
      ...(data.endGranularity !== undefined
        ? { endGranularity: data.endGranularity }
        : {}),
      precision: data.precision ?? "exact",
      kind: data.kind ?? "generic",
      secret: data.secret ?? false,
      revealSceneId: data.revealSceneId ?? null,
    },
    manualApiWriteOpts(data.projectId),
  );
  const row = await getEvent(data.projectId, id);
  if (!row) {
    throw new Error(
      `Created event '${id}' not found in project '${data.projectId}'`,
    );
  }
  return row;
}

export async function updateEvent(
  id: string,
  projectId: string,
  patch: Partial<
    Pick<
      EventRow,
      | "title"
      | "note"
      | "detail"
      | "ordinal"
      | "primaryCodexId"
      | "locationCodexId"
      | "startTime"
      | "endTime"
      | "startMinute"
      | "endMinute"
      | "startGranularity"
      | "endGranularity"
      | "precision"
      | "kind"
      | "secret"
      | "revealSceneId"
    >
  >,
  opts?: { baseVersion?: number },
): Promise<EventRow | null> {
  const current = await getEvent(projectId, id);
  if (!current) return null;
  const baseVersion = opts?.baseVersion ?? current.version;
  try {
    await agentUpdateEvent(
      { eventId: id, baseVersion, ...patch },
      manualApiWriteOpts(projectId),
    );
  } catch (err) {
    rethrowEventVersionConflict(id, err);
  }
  const updated = await getEvent(projectId, id);
  return updated;
}

export async function deleteEvent(
  id: string,
  projectId: string,
): Promise<void> {
  const current = await getEvent(projectId, id);
  if (!current) return;
  await agentDeleteEvent(id, {
    ...manualApiWriteOpts(projectId),
    baseVersion: current.version,
  });
}

// ───────── participants ─────────
export interface ParticipantRow {
  eventId: string;
  codexEntryId: string;
  role: string | null;
}

export async function listEventParticipants(
  eventId: string,
): Promise<ParticipantRow[]> {
  const rows = await db
    .select()
    .from(eventParticipants)
    .where(eq(eventParticipants.eventId, eventId));
  return rows.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      eventId: s(r.eventId ?? r.event_id),
      codexEntryId: s(r.codexEntryId ?? r.codex_entry_id),
      role: nullableStr(r.role),
    };
  });
}

/** 参加者集合を置き換える（全削除→再挿入）。role は当面 null 固定で良い。 */
export async function setEventParticipants(
  eventId: string,
  projectId: string,
  codexEntryIds: string[],
  opts?: { baseVersion?: number },
): Promise<number | null> {
  const [ev] = await db
    .select({ id: events.id, version: events.version })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.projectId, projectId)));
  if (!ev) return null;
  const baseVersion = opts?.baseVersion ?? ev.version;
  try {
    const result = await agentSetEventParticipants(eventId, codexEntryIds, {
      ...manualApiWriteOpts(projectId),
      baseVersion,
    });
    return result.version;
  } catch (err) {
    rethrowEventVersionConflict(eventId, err);
  }
}

/**
 * project スコープで参加者を一括取得（XPROJ 安全）。
 * event_participants は project_id 列を持たないため events へ INNER JOIN し
 * events.project_id でスコープする。AI / MCP / write 経路はこの API のみ使う
 * （素の listEventParticipants(eventId) は project gate が無いため AI 経路では禁止）。
 * @param eventIds undefined=project 全件 / [] = 0 件（フィルタ対象なし）。
 */
export async function listEventParticipantsForProject(
  projectId: string,
  eventIds?: string[],
): Promise<ParticipantRow[]> {
  if (eventIds && eventIds.length === 0) return [];
  const conds = [eq(events.projectId, projectId)];
  if (eventIds) conds.push(inArray(eventParticipants.eventId, eventIds));
  const rows = await db
    .select({
      eventId: eventParticipants.eventId,
      codexEntryId: eventParticipants.codexEntryId,
      role: eventParticipants.role,
    })
    .from(eventParticipants)
    .innerJoin(events, eq(eventParticipants.eventId, events.id))
    .where(and(...conds));
  return rows.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      eventId: s(r.eventId ?? r.event_id),
      codexEntryId: s(r.codexEntryId ?? r.codex_entry_id),
      role: nullableStr(r.role),
    };
  });
}

// ───────── scene_events 橋 ─────────
export interface SceneEventRow {
  sceneId: string;
  eventId: string;
}

export async function listSceneEvents(
  eventIds: string[],
): Promise<SceneEventRow[]> {
  if (eventIds.length === 0) return [];
  const rows = await db
    .select()
    .from(sceneEvents)
    .where(inArray(sceneEvents.eventId, eventIds));
  return rows.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      sceneId: s(r.sceneId ?? r.scene_id),
      eventId: s(r.eventId ?? r.event_id),
    };
  });
}

/**
 * project スコープで scene↔event 橋を一括取得（XPROJ 安全）。
 * scene_events は project_id 列を持たないため events へ INNER JOIN し
 * events.project_id でスコープする。AI / MCP 経路はこの API のみ使う。
 * @param opts.eventIds / opts.sceneIds いずれも [] は 0 件（フィルタ対象なし）。
 */
export async function listSceneEventsForProject(
  projectId: string,
  opts?: { eventIds?: string[]; sceneIds?: string[] },
): Promise<SceneEventRow[]> {
  if (opts?.eventIds && opts.eventIds.length === 0) return [];
  if (opts?.sceneIds && opts.sceneIds.length === 0) return [];
  const conds = [eq(events.projectId, projectId)];
  if (opts?.eventIds) conds.push(inArray(sceneEvents.eventId, opts.eventIds));
  if (opts?.sceneIds) conds.push(inArray(sceneEvents.sceneId, opts.sceneIds));
  const rows = await db
    .select({ sceneId: sceneEvents.sceneId, eventId: sceneEvents.eventId })
    .from(sceneEvents)
    .innerJoin(events, eq(sceneEvents.eventId, events.id))
    .where(and(...conds));
  return rows.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      sceneId: s(r.sceneId ?? r.scene_id),
      eventId: s(r.eventId ?? r.event_id),
    };
  });
}

export async function linkSceneToEvent(
  projectId: string,
  sceneId: string,
  eventId: string,
): Promise<void> {
  const [scene] = await db
    .select({ id: treeNodes.id })
    .from(treeNodes)
    .where(and(eq(treeNodes.id, sceneId), eq(treeNodes.projectId, projectId)));
  if (!scene) return;
  const [event] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.projectId, projectId)));
  if (!event) return;
  await agentLinkSceneEvent(sceneId, eventId, manualApiWriteOpts(projectId));
}

/**
 * 1 event へ複数シーンを一括リンク（importExtractedEvents 用）。
 * linkSceneToEvent をシーンごとに呼ぶと検証 SELECT が 2×N 回走る（N+1）ため、
 * event 検証 1 回＋scene 検証を inArray で 1 回に畳み、insert も 1 文にする。
 * 挙動は per-scene 呼び出しと同じ（不正 id は黙ってスキップ / 既存リンクは
 * onConflictDoNothing / timelapse 記録はリンクごと）。
 */
export async function linkScenesToEvent(
  projectId: string,
  sceneIds: string[],
  eventId: string,
): Promise<void> {
  if (sceneIds.length === 0) return;
  const [event] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.projectId, projectId)));
  if (!event) return;
  const sceneRows = await db
    .select({ id: treeNodes.id })
    .from(treeNodes)
    .where(
      and(inArray(treeNodes.id, sceneIds), eq(treeNodes.projectId, projectId)),
    );
  const valid = new Set(sceneRows.map((r) => r.id));
  const targets = [...new Set(sceneIds)].filter((id) => valid.has(id));
  const writeOpts = manualApiWriteOpts(projectId);
  for (const sceneId of targets) {
    await agentLinkSceneEvent(sceneId, eventId, writeOpts);
  }
}

export async function unlinkSceneFromEvent(
  projectId: string,
  sceneId: string,
  eventId: string,
): Promise<void> {
  // scene_events は project_id 列を持たないため、対象 event が projectId に
  // 属する時のみ削除する（XPROJ fail-closed：他プロジェクトの id を渡されても
  // no-op。linkSceneToEvent と対称な projectId-first シグネチャ）。
  const [event] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.projectId, projectId)));
  if (!event) return;
  await agentUnlinkSceneEvent(sceneId, eventId, manualApiWriteOpts(projectId));
}

// ───────── project_calendar ─────────
export interface CalendarRow {
  projectId: string;
  daysPerYear: number;
  /** 生 JSON 文字列（SeasonBoundary[]）。パースは chronicleTime 利用側で。 */
  seasonBoundaries: string;
  /** 暦の開始年ラベル。 */
  startYear: number;
  /** 生 JSON 文字列（MonthDef[]）。'[]'=月概念なし。 */
  months: string;
  /** 生 JSON 文字列（string[] 曜日名）。'[]'=曜日概念なし。 */
  weekdayNames: string;
  /** day番号0に対応する weekdayNames の index。 */
  weekdayStartIndex: number;
  /** 生 JSON 文字列（LeapRule）。'{"kind":"none"}'=閏年なし。 */
  leapRule: string;
  /** 年齢の数え方。'full'=満年齢 / 'counting'=数え年。 */
  ageReckoning: string;
  /** 生 JSON 文字列（EraDef[] 元号/年号）。'[]'=元号なし。 */
  eras: string;
  /** 生 JSON 文字列（CalendarReform | null 改暦）。'null'=改暦なし。 */
  reform: string;
  /** 生 JSON 文字列（TimeZoneDef | null タイムゾーン）。'null'=なし。 */
  timezone: string;
  /** 旧暦の節気判定 UTC オフセット分（480=中国 / 540=日本）。 */
  lunarTzMinutes: number;
  /** Calendar aggregate OCC generation. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export async function getProjectCalendar(
  projectId: string,
): Promise<CalendarRow | null> {
  const [raw] = await db
    .select()
    .from(projectCalendar)
    .where(eq(projectCalendar.projectId, projectId));
  if (!raw) return null;
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

export async function upsertProjectCalendar(
  data: {
    projectId: string;
    daysPerYear: number;
    seasonBoundaries: string;
    startYear?: number;
    months?: string;
    weekdayNames?: string;
    weekdayStartIndex?: number;
    leapRule?: string;
    ageReckoning?: string;
    eras?: string;
    reform?: string;
    timezone?: string;
    lunarTzMinutes?: number;
  },
  options: { baseVersion: number | null },
): Promise<CalendarRow> {
  const now = new Date().toISOString();
  const persisted = await invoke<CalendarRow | null>(
    "project_calendar_upsert",
    {
      payload: {
        projectId: data.projectId,
        daysPerYear: data.daysPerYear,
        seasonBoundaries: data.seasonBoundaries,
        startYear: data.startYear ?? 0,
        months: data.months ?? "[]",
        weekdayNames: data.weekdayNames ?? "[]",
        weekdayStartIndex: data.weekdayStartIndex ?? 0,
        leapRule: data.leapRule ?? '{"kind":"none"}',
        ageReckoning: data.ageReckoning ?? "full",
        eras: data.eras ?? "[]",
        reform: data.reform ?? "null",
        timezone: data.timezone ?? "null",
        lunarTzMinutes: data.lunarTzMinutes ?? 480,
        baseVersion: options.baseVersion,
        updatedAt: now,
      },
    },
  );
  if (!persisted) {
    throw new ProjectCalendarVersionConflictError(data.projectId);
  }
  bumpChronicleRevision();
  recordEvent(data.projectId, "calendar.update", null, {
    projectId: data.projectId,
    daysPerYear: data.daysPerYear,
    version: persisted.version,
  });
  return {
    projectId: persisted.projectId,
    daysPerYear: Number(persisted.daysPerYear),
    seasonBoundaries: persisted.seasonBoundaries,
    startYear: Number(persisted.startYear),
    months: persisted.months,
    weekdayNames: persisted.weekdayNames,
    weekdayStartIndex: Number(persisted.weekdayStartIndex),
    leapRule: persisted.leapRule,
    ageReckoning: persisted.ageReckoning,
    eras: persisted.eras,
    reform: persisted.reform,
    timezone: persisted.timezone,
    lunarTzMinutes: Number(persisted.lunarTzMinutes),
    version: Number(persisted.version),
    createdAt: persisted.createdAt,
    updatedAt: persisted.updatedAt,
  };
}

// ───────── event_relations（因果エッジ） ─────────
export interface EventRelationRow {
  causeId: string;
  effectId: string;
}

export async function listEventRelations(
  projectId: string,
): Promise<EventRelationRow[]> {
  const rows = await db
    .select()
    .from(eventRelations)
    .where(eq(eventRelations.projectId, projectId));
  return rows.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      causeId: s(r.causeEventId ?? r.cause_event_id),
      effectId: s(r.effectEventId ?? r.effect_event_id),
    };
  });
}

export async function addEventRelation(
  projectId: string,
  causeId: string,
  effectId: string,
): Promise<void> {
  if (causeId === effectId) return; // 自己因果は無効
  const scopedEvents = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        inArray(events.id, [causeId, effectId]),
      ),
    );
  const ids = new Set(scopedEvents.map((e) => e.id));
  if (!ids.has(causeId) || !ids.has(effectId)) return;
  await agentAddEventRelation(causeId, effectId, manualApiWriteOpts(projectId));
}

export async function removeEventRelation(
  projectId: string,
  causeId: string,
  effectId: string,
): Promise<void> {
  await agentRemoveEventRelation(
    causeId,
    effectId,
    manualApiWriteOpts(projectId),
  );
}
