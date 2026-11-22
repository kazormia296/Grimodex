import { db } from "@/db/client";
import { invoke } from "@/lib/tauri";
import { events, eventParticipants, sceneEvents, treeNodes } from "@/db/schema";
import type { EventPrecision, EventKind, EventGranularity } from "@/db/schema";
import type {
  CalendarRow,
  EventRow,
  ParticipantRow,
  SceneEventRow,
  EventRelationRow,
} from "@/../electron/shared/readDomain/features/chronicle/eventRows";
// 行の型の正本は shared module（MP-4b PR-3b-2。CalendarRow は PR-7a）。ここでは後方互換のため再エクスポートする。
export type {
  CalendarRow,
  EventRow,
  ParticipantRow,
  SceneEventRow,
  EventRelationRow,
} from "@/../electron/shared/readDomain/features/chronicle/eventRows";
// 読み取りの行の正規化と SQL は共有 core 側（MP-4b PR-7a）。read の 5 関数は reader への薄い委譲。
import {
  normalizeEvent,
  normalizeParticipantRow,
  normalizeSceneEventRow,
} from "@/../electron/shared/readDomain/features/chronicle/readRows";
import {
  readEventParticipantsForProject,
  readEventRelations,
  readEvents,
  readProjectCalendar,
  readSceneEventsForProject,
} from "@/../electron/shared/readDomain/core/chronicleReaders";
import { and, asc, eq, inArray } from "drizzle-orm";
import { nextEventOrdinal } from "./chronicleTime";
// 暦復元の正本は chronicleTime（純粋モジュール）へ集約。ここでは後方互換の再エクスポート。
export { calendarFromRow } from "./chronicleTime";
import { useChronicleStore } from "./chronicleStore";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { EventVersionConflictError } from "./eventOcc";
import { ProjectCalendarVersionConflictError } from "./calendarOcc";
import {
  agentCreateEvent,
  agentUpdateEvent,
  agentDeleteEvent,
  agentLinkSceneEvent,
  agentLinkSceneEventsBatch,
  agentUnlinkSceneEvent,
  agentAddEventRelation,
  agentRemoveEventRelation,
  agentSetEventParticipants,
} from "@/features/agent-writes/event";

/**
 * 年表 mutation 後に AI コンテキストの鮮度カウンタを上げる（C3 prompt 鮮度）。
 * UI / 抽出ウィザード / 将来の agent・MCP write が全てこの API を通るため、ここを
 * 単一チョークポイントにすれば全経路で contextPromptKey が更新される。
 */
function bumpChronicleRevision(): void {
  useChronicleStore.getState().bumpRevision();
}

type ChronicleApiWriteOrigin = "human" | "import";

interface ChronicleApiWriteOptions {
  origin?: ChronicleApiWriteOrigin;
}

/** Human / import api 経路の Native writer 呼び出し既定値。 */
function manualApiWriteOpts(
  projectId: string,
  origin: ChronicleApiWriteOrigin = "human",
) {
  return {
    surface: origin === "import" ? ("import" as const) : ("manual" as const),
    skipPolicyGate: true,
    commandFamily: "renderer" as const,
    projectId,
    requestId: crypto.randomUUID(),
  };
}

function rethrowEventVersionConflict(eventId: string, err: unknown): never {
  if (err instanceof Error && err.message.includes("version conflict")) {
    throw new EventVersionConflictError(eventId);
  }
  throw err;
}

export { normalizeEvent };

/**
 * project の全出来事（ordinal,id の二段ソート）。SQL は共有 core の reader
 * （`readDomain/core/chronicleReaders.ts`）にあり、ここは renderer の `db` で呼ぶだけ
 * （MP-4b PR-7a。Main の read core も同じ文を使う）。
 */
export async function listEvents(projectId: string): Promise<EventRow[]> {
  return readEvents(db, projectId);
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

export async function createEvent(
  data: {
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
  },
  opts: ChronicleApiWriteOptions = {},
): Promise<EventRow> {
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
  const writeOpts = manualApiWriteOpts(data.projectId, opts.origin);
  await agentCreateEvent(
    {
      requestId: writeOpts.requestId,
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
    writeOpts,
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

export async function listEventParticipants(
  eventId: string,
): Promise<ParticipantRow[]> {
  const rows = await db
    .select()
    .from(eventParticipants)
    .where(eq(eventParticipants.eventId, eventId));
  return rows.map(normalizeParticipantRow);
}

/** 参加者集合を置き換える（全削除→再挿入）。role は当面 null 固定で良い。 */
export async function setEventParticipants(
  eventId: string,
  projectId: string,
  codexEntryIds: string[],
  opts?: { baseVersion?: number; origin?: ChronicleApiWriteOrigin },
): Promise<number | null> {
  const [ev] = await db
    .select({ id: events.id, version: events.version })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.projectId, projectId)));
  if (!ev) return null;
  const baseVersion = opts?.baseVersion ?? ev.version;
  try {
    const result = await agentSetEventParticipants(eventId, codexEntryIds, {
      ...manualApiWriteOpts(projectId, opts?.origin),
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
  return readEventParticipantsForProject(db, projectId, eventIds);
}

// ───────── scene_events 橋 ─────────

export async function listSceneEvents(
  eventIds: string[],
): Promise<SceneEventRow[]> {
  if (eventIds.length === 0) return [];
  const rows = await db
    .select()
    .from(sceneEvents)
    .where(inArray(sceneEvents.eventId, eventIds));
  return rows.map(normalizeSceneEventRow);
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
  return readSceneEventsForProject(db, projectId, opts);
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
 * event 検証 1 回＋scene 検証を inArray で 1 回に畳み、native の一括書き込みへ渡す。
 * 挙動は per-scene 呼び出しと同じ（不正 id は黙ってスキップ / 既存リンクは
 * no-op）。timelapse には実際に追加された sceneIds を 1 batch event で記録する。
 */
export async function linkScenesToEvent(
  projectId: string,
  sceneIds: string[],
  eventId: string,
  opts: ChronicleApiWriteOptions = {},
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
      and(
        inArray(treeNodes.id, sceneIds),
        eq(treeNodes.projectId, projectId),
        eq(treeNodes.nodeType, "scene"),
      ),
    );
  const valid = new Set(sceneRows.map((r) => r.id));
  const targets = [...new Set(sceneIds)].filter((id) => valid.has(id));
  if (targets.length === 0) return;
  await agentLinkSceneEventsBatch(
    targets,
    eventId,
    manualApiWriteOpts(projectId, opts.origin),
  );
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
export async function getProjectCalendar(
  projectId: string,
): Promise<CalendarRow | null> {
  return readProjectCalendar(db, projectId);
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
  const requestId = crypto.randomUUID();
  const persisted = await invoke<CalendarRow | null>(
    "project_calendar_upsert",
    {
      payload: {
        projectId: data.projectId,
        requestId,
        sessionId: getRecorderSessionId(),
        eventUid: requestId,
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

export async function listEventRelations(
  projectId: string,
): Promise<EventRelationRow[]> {
  return readEventRelations(db, projectId);
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
