import { db } from "@/db/client";
import {
  events,
  eventParticipants,
  sceneEvents,
  projectCalendar,
  eventRelations,
  treeNodes,
} from "@/db/schema";
import type { EventPrecision, EventKind } from "@/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { nextEventOrdinal } from "./chronicleTime";
import { useChronicleStore } from "./chronicleStore";

/**
 * 年表 mutation 後に AI コンテキストの鮮度カウンタを上げる（C3 prompt 鮮度）。
 * UI / 抽出ウィザード / 将来の agent・MCP write が全てこの API を通るため、ここを
 * 単一チョークポイントにすれば全経路で contextPromptKey が更新される。
 */
function bumpChronicleRevision(): void {
  useChronicleStore.getState().bumpRevision();
}

export interface EventRow {
  id: string;
  projectId: string;
  title: string;
  note: string | null;
  ordinal: string;
  primaryCodexId: string | null;
  locationCodexId: string | null;
  startTime: number | null;
  endTime: number | null;
  precision: EventPrecision;
  kind: EventKind;
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

/** DB 行（snake_case）/ invoke 戻り値（camelCase）双方を EventRow へ正規化。 */
export function normalizeEvent(raw: unknown): EventRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: s(r.id),
    projectId: s(r.projectId ?? r.project_id),
    title: s(r.title),
    note: nullableStr(r.note),
    ordinal: s(r.ordinal, "a0"),
    primaryCodexId: nullableStr(r.primaryCodexId ?? r.primary_codex_id),
    locationCodexId: nullableStr(r.locationCodexId ?? r.location_codex_id),
    startTime: nullableNum(r.startTime ?? r.start_time),
    endTime: nullableNum(r.endTime ?? r.end_time),
    precision: s(r.precision, "exact") as EventPrecision,
    kind: s(r.kind, "generic") as EventKind,
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

export async function createEvent(data: {
  projectId: string;
  title?: string;
  note?: string | null;
  ordinal?: string;
  primaryCodexId?: string | null;
  locationCodexId?: string | null;
  startTime?: number | null;
  endTime?: number | null;
  precision?: EventPrecision;
  kind?: EventKind;
}): Promise<EventRow> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  let ordinal = data.ordinal;
  // ordinal 自動採番（max の次）は read→insert の競合に弱い。max 読取と insert を
  // 1 transaction に閉じることで、二重発火時の ordinal 衝突を防ぐ。
  await db.transaction(async (tx) => {
    if (ordinal === undefined) {
      const existing = await tx
        .select()
        .from(events)
        .where(eq(events.projectId, data.projectId))
        .orderBy(asc(events.ordinal), asc(events.id));
      ordinal = nextEventOrdinal(
        existing.map((e) => normalizeEvent(e).ordinal),
      );
    }
    await tx.insert(events).values({
      id,
      projectId: data.projectId,
      title: data.title ?? "",
      note: data.note ?? null,
      ordinal,
      primaryCodexId: data.primaryCodexId ?? null,
      locationCodexId: data.locationCodexId ?? null,
      startTime: data.startTime ?? null,
      endTime: data.endTime ?? null,
      precision: data.precision ?? "exact",
      kind: data.kind ?? "generic",
      createdAt: now,
      updatedAt: now,
    });
  });
  const [row] = await db.select().from(events).where(eq(events.id, id));
  bumpChronicleRevision();
  return normalizeEvent(row);
}

export async function updateEvent(
  id: string,
  projectId: string,
  patch: Partial<
    Pick<
      EventRow,
      | "title"
      | "note"
      | "ordinal"
      | "primaryCodexId"
      | "locationCodexId"
      | "startTime"
      | "endTime"
      | "precision"
      | "kind"
    >
  >,
): Promise<void> {
  // projectId を WHERE に AND して fail-closed にする（他プロジェクトの id を
  // 渡されても no-op で、cross-project の書込みを構造的に遮断）。
  await db
    .update(events)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(and(eq(events.id, id), eq(events.projectId, projectId)));
  bumpChronicleRevision();
}

export async function deleteEvent(
  id: string,
  projectId: string,
): Promise<void> {
  // fail-closed: id と projectId の両方一致でのみ削除（cross-project 遮断）。
  await db
    .delete(events)
    .where(and(eq(events.id, id), eq(events.projectId, projectId)));
  bumpChronicleRevision();
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
  codexEntryIds: string[],
): Promise<void> {
  // 全削除→再挿入を 1 transaction に閉じ、insert 失敗時に delete を巻き戻して
  // 参加者集合が中途半端に空になるのを防ぐ（atomic な置換）。
  await db.transaction(async (tx) => {
    await tx
      .delete(eventParticipants)
      .where(eq(eventParticipants.eventId, eventId));
    if (codexEntryIds.length === 0) return;
    await tx
      .insert(eventParticipants)
      .values(codexEntryIds.map((codexEntryId) => ({ eventId, codexEntryId })));
  });
  bumpChronicleRevision();
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
  await db
    .insert(sceneEvents)
    .values({ sceneId, eventId })
    .onConflictDoNothing();
  bumpChronicleRevision();
}

export async function unlinkSceneFromEvent(
  sceneId: string,
  eventId: string,
): Promise<void> {
  await db
    .delete(sceneEvents)
    .where(
      and(eq(sceneEvents.sceneId, sceneId), eq(sceneEvents.eventId, eventId)),
    );
  bumpChronicleRevision();
}

// ───────── project_calendar ─────────
export interface CalendarRow {
  projectId: string;
  daysPerYear: number;
  /** 生 JSON 文字列（SeasonBoundary[]）。パースは chronicleTime 利用側で。 */
  seasonBoundaries: string;
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
    createdAt: s(r.createdAt ?? r.created_at),
    updatedAt: s(r.updatedAt ?? r.updated_at),
  };
}

export async function upsertProjectCalendar(data: {
  projectId: string;
  daysPerYear: number;
  seasonBoundaries: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(projectCalendar)
    .values({
      projectId: data.projectId,
      daysPerYear: data.daysPerYear,
      seasonBoundaries: data.seasonBoundaries,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: projectCalendar.projectId,
      set: {
        daysPerYear: data.daysPerYear,
        seasonBoundaries: data.seasonBoundaries,
        updatedAt: now,
      },
    });
  bumpChronicleRevision();
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
  await db
    .insert(eventRelations)
    .values({
      projectId,
      causeEventId: causeId,
      effectEventId: effectId,
    })
    .onConflictDoNothing();
  bumpChronicleRevision();
}

export async function removeEventRelation(
  projectId: string,
  causeId: string,
  effectId: string,
): Promise<void> {
  // fail-closed: projectId も AND し、他プロジェクトのエッジを消せないようにする
  // （addEventRelation と同じ projectId-first シグネチャに揃える）。
  await db
    .delete(eventRelations)
    .where(
      and(
        eq(eventRelations.projectId, projectId),
        eq(eventRelations.causeEventId, causeId),
        eq(eventRelations.effectEventId, effectId),
      ),
    );
  bumpChronicleRevision();
}
